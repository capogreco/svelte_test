<script lang="ts">
    import type { Snippet } from 'svelte'
    import { onMount, onDestroy } from 'svelte'
    import AuthCheck from '$lib/components/AuthCheck.svelte'
    import { db } from '$lib/firebase'
    import { ref, onValue, off } from 'firebase/database'
    import { browser } from '$app/environment'
    import { activeControllerId } from '$lib/stores/controllerStore'
    
    let { children }: { children: Snippet } = $props()
    let connections = []
    let cnv: HTMLCanvasElement
    let ctx: CanvasRenderingContext2D
    let animationFrameId: number
    let unsubscribeConnections: () => void
    let currentCtrlId: string | null = null
    
    // Subscribe to changes in the active controller ID
    activeControllerId.subscribe(value => {
      currentCtrlId = value
    })

    const colors = {
      connected: 'rgba(56, 189, 248, 0.3)',
      disconnected: 'rgba(251, 113, 133, 0.15)',
      line: 'rgba(148, 163, 184, 0.15)'
    }

    // Draw connections visualization on the canvas
    const drawConnections = () => {
      // Skip if we're server-side rendering or context is not available
      if (!browser || !ctx || !cnv) return
      
      const width = cnv.width
      const height = cnv.height
      const timestamp = Date.now() / 1000 // Current time in seconds for animations
      
      // Clear canvas with very subtle background
      ctx.clearRect(0, 0, width, height)
      ctx.fillStyle = 'rgba(0, 0, 0, 0.01)'
      ctx.fillRect(0, 0, width, height)
      
      if (connections.length === 0) return
      
      // Draw controller in the center
      const centerX = width / 2
      const centerY = height / 2
      
      // Animation for controller node - pulsating effect
      const pulseSize = 20 + Math.sin(timestamp) * 3
      
      // Draw controller node with glow effect
      ctx.beginPath()
      const gradient = ctx.createRadialGradient(
        centerX, centerY, 0,
        centerX, centerY, pulseSize * 2
      )
      gradient.addColorStop(0, 'rgba(56, 189, 248, 0.7)')
      gradient.addColorStop(0.7, 'rgba(56, 189, 248, 0.3)')
      gradient.addColorStop(1, 'rgba(56, 189, 248, 0)')
      
      ctx.arc(centerX, centerY, pulseSize * 2, 0, Math.PI * 2)
      ctx.fillStyle = gradient
      ctx.fill()
      
      // Inner controller node
      ctx.beginPath()
      ctx.arc(centerX, centerY, pulseSize, 0, Math.PI * 2)
      ctx.fillStyle = 'rgba(56, 189, 248, 0.7)'
      ctx.fill()
      
      // Calculate positions for synth nodes in a circular pattern
      // For many connections, we'll use a spiral pattern to fit more
      connections.forEach((conn, i) => {
        // Use a spiral layout if we have many connections
        const spiralFactor = connections.length > 30 ? 0.1 : 0
        const angle = (i / (connections.length || 1)) * Math.PI * 2
        
        // Base radius adjusted by connection count
        const baseRadius = Math.min(width, height) * 
          (0.35 - (Math.min(0.15, (connections.length / 1000)))) // Shrink as count increases
          
        // Apply spiral effect and slight randomization for organic feel
        const uniqueOffset = (conn.id.charCodeAt(0) % 10) / 100 // Small variation based on ID
        const radiusMod = baseRadius * (1 + (i * spiralFactor) + uniqueOffset)
        
        // Slight oscillation for position
        const oscillation = Math.sin(timestamp + i * 0.5) * 5
        
        const x = centerX + radiusMod * Math.cos(angle) + oscillation * Math.sin(i)
        const y = centerY + radiusMod * Math.sin(angle) + oscillation * Math.cos(i)
        
        // Determine if this is the active controller for this user
        const isCurrentUserController = conn.controllerId === currentCtrlId
        
        // Create animated data flow on the connection line
        ctx.beginPath()
        ctx.moveTo(centerX, centerY)
        
        // Use bezier curve for more organic connections
        const controlPointDistance = radiusMod * 0.4
        const cpX1 = centerX + controlPointDistance * Math.cos(angle - 0.2)
        const cpY1 = centerY + controlPointDistance * Math.sin(angle - 0.2)
        const cpX2 = x - controlPointDistance * Math.cos(angle - 0.2) 
        const cpY2 = y - controlPointDistance * Math.sin(angle - 0.2)
        
        ctx.bezierCurveTo(cpX1, cpY1, cpX2, cpY2, x, y)
        
        // Make lines for current user's controller more prominent
        ctx.strokeStyle = isCurrentUserController 
          ? 'rgba(148, 163, 184, 0.4)' 
          : 'rgba(148, 163, 184, 0.15)'
        ctx.lineWidth = isCurrentUserController ? 3 : 1.5
        ctx.stroke()
        
        // Animate data packets traveling along the connections
        if (conn.isConnected) {
          const packetOffset = (timestamp * 0.5 + i * 0.7) % 1 // Value 0-1 for position along path
          
          // Calculate position along the bezier curve
          const t = packetOffset
          const dataX = Math.pow(1-t, 3) * centerX + 
                      3 * Math.pow(1-t, 2) * t * cpX1 + 
                      3 * (1-t) * Math.pow(t, 2) * cpX2 + 
                      Math.pow(t, 3) * x
          const dataY = Math.pow(1-t, 3) * centerY + 
                      3 * Math.pow(1-t, 2) * t * cpY1 + 
                      3 * (1-t) * Math.pow(t, 2) * cpY2 + 
                      Math.pow(t, 3) * y
          
          // Draw data packet
          ctx.beginPath()
          ctx.arc(dataX, dataY, 4, 0, Math.PI * 2)
          ctx.fillStyle = 'rgba(56, 189, 248, 0.8)'
          ctx.fill()
        }
        
        // Draw synth node with subtle animation
        const nodeSize = 8 + (conn.isConnected ? Math.sin(timestamp + i) * 2 : 0)
        
        ctx.beginPath()
        ctx.arc(x, y, nodeSize, 0, Math.PI * 2)
        
        // Highlight current user's connections
        const fillColor = isCurrentUserController
          ? (conn.isConnected ? 'rgba(56, 189, 248, 0.6)' : 'rgba(251, 113, 133, 0.4)')
          : (conn.isConnected ? 'rgba(56, 189, 248, 0.3)' : 'rgba(251, 113, 133, 0.2)')
        
        ctx.fillStyle = fillColor
        ctx.fill()
        
        // Add subtle glow for connected nodes
        if (conn.isConnected && isCurrentUserController) {
          ctx.beginPath()
          const nodeGradient = ctx.createRadialGradient(
            x, y, 0,
            x, y, nodeSize * 2
          )
          nodeGradient.addColorStop(0, 'rgba(56, 189, 248, 0.2)')
          nodeGradient.addColorStop(1, 'rgba(56, 189, 248, 0)')
          
          ctx.arc(x, y, nodeSize * 2, 0, Math.PI * 2)
          ctx.fillStyle = nodeGradient
          ctx.fill()
        }
      })
    }

    // Animation loop
    const animate = () => {
      // Skip if we're server-side rendering
      if (!browser) return
      
      drawConnections()
      animationFrameId = requestAnimationFrame(animate)
    }

    // Set up canvas for full screen
    const setupCanvas = () => {
      // Skip if we're server-side rendering or canvas isn't available
      if (!browser || !cnv) return
      
      cnv.width = window.innerWidth
      cnv.height = window.innerHeight
      
      // Get context with transparency
      ctx = cnv.getContext('2d', { alpha: true })
      
      // Start animation
      if (animationFrameId) cancelAnimationFrame(animationFrameId)
      animationFrameId = requestAnimationFrame(animate)
    }

    onMount(() => {
      // Check if we're in the browser environment
      if (browser) {
        cnv = document.getElementById('cnv') as HTMLCanvasElement
        setupCanvas()
        
        // Update canvas on resize
        window.addEventListener('resize', setupCanvas)
      }
      
      // Listen for synth connections in all controllers
      try {
        const synthOffersRef = ref(db, 'synthOffers')
        unsubscribeConnections = onValue(synthOffersRef, (snapshot) => {
          const data = snapshot.val()
          if (!data) {
            connections = []
            return
          }
          
          // Get all synth connections across all controllers
          const allConnections = []
          Object.entries(data).forEach(([ctrlId, synthOffers]) => {
            if (!synthOffers) return
            
            Object.keys(synthOffers).forEach(synthId => {
              allConnections.push({
                id: synthId,
                controllerId: ctrlId,
                isConnected: true, // It exists in Firebase, so there's some connection
                timestamp: Date.now()
              })
            })
          })
          
          connections = allConnections
        })
      } catch (err) {
        console.error('Error setting up connection visualization:', err)
      }
    })

    onDestroy(() => {
      // Only execute browser-specific cleanup in the browser
      if (browser) {
        if (animationFrameId) cancelAnimationFrame(animationFrameId)
        window.removeEventListener('resize', setupCanvas)
      }
      
      if (unsubscribeConnections) unsubscribeConnections()
    })
</script>

<canvas id="cnv" style="position:absolute; z-index:-1; background-color: rgba(10, 15, 25, 0.9);" ></canvas>

<main class="flex flex-col items-center justify-center min-h-screen">
    <AuthCheck>
        {@render children ()}
    </AuthCheck>
</main>  
