import { writable } from 'svelte/store'

// Create a store for the controller ID that components can access
export const activeControllerId = writable<string | null>(null)