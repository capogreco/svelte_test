/**
 * WebRTC Logger
 * Provides utilities for logging WebRTC-related events to files and console
 */
import { browser } from '$app/environment';

// Define log levels
export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3
}

// Configuration for the logger
export interface LoggerConfig {
  minLevel: LogLevel;
  toConsole: boolean;
  toFile: boolean;
  maxLogSize: number;
  maxLogFiles: number;
  fileName: string;
}

// Default configuration
const DEFAULT_CONFIG: LoggerConfig = {
  minLevel: LogLevel.DEBUG,
  toConsole: true,
  toFile: true,
  maxLogSize: 5 * 1024 * 1024, // 5MB
  maxLogFiles: 3,
  fileName: 'webrtc-log'
};

// Original console methods
const originalConsole = {
  log: console.log,
  info: console.info,
  warn: console.warn,
  error: console.error,
  debug: console.debug
};

// Flag to prevent recursion
let isLogging = false;

// Logger class
export class WebRTCLogger {
  private config: LoggerConfig;
  private logs: string[] = [];
  private clientId: string = 'unknown';
  private logType: 'ctrl' | 'synth' | 'unknown' = 'unknown';
  private lastFlush: number = Date.now();

  constructor(config: Partial<LoggerConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    // Generate a unique ID for this logger instance
    this.clientId = Date.now().toString(36) + Math.random().toString(36).substring(2);
  }

  // Set client type and ID
  public setClient(type: 'ctrl' | 'synth', id: string) {
    this.logType = type;
    this.clientId = id;
    this.log(LogLevel.INFO, 'Logger', `Logger configured for ${type} client with ID ${id}`);
  }

  // Log a message
  public log(level: LogLevel, category: string, message: string, data?: any) {
    // Prevent recursion
    if (isLogging) return;
    isLogging = true;
    
    try {
      if (level < this.config.minLevel) {
        isLogging = false;
        return;
      }

      const timestamp = new Date().toISOString();
      const levelString = LogLevel[level];
      const formattedMessage = `[${timestamp}] [${levelString}] [${this.logType}:${this.clientId}] [${category}] ${message}`;
      
      // Add formatted data if present
      const fullMessage = data ? 
        `${formattedMessage}\n  Data: ${typeof data === 'object' ? JSON.stringify(data) : data}` : 
        formattedMessage;

      // Add to in-memory logs
      this.logs.push(fullMessage);
      
      // Print to console if enabled
      if (this.config.toConsole) {
        switch (level) {
          case LogLevel.DEBUG:
            originalConsole.debug(fullMessage);
            break;
          case LogLevel.INFO:
            originalConsole.info(fullMessage);
            break;
          case LogLevel.WARN:
            originalConsole.warn(fullMessage);
            break;
          case LogLevel.ERROR:
            originalConsole.error(fullMessage);
            break;
        }
      }
      
      // Flush to file periodically (every 5 seconds or 100 messages)
      if (this.config.toFile && browser && 
          (this.logs.length > 100 || Date.now() - this.lastFlush > 5000)) {
        this.flush();
      }
    } finally {
      isLogging = false;
    }
  }
  
  // Debug level log
  public debug(category: string, message: string, data?: any) {
    this.log(LogLevel.DEBUG, category, message, data);
  }
  
  // Info level log
  public info(category: string, message: string, data?: any) {
    this.log(LogLevel.INFO, category, message, data);
  }
  
  // Warning level log
  public warn(category: string, message: string, data?: any) {
    this.log(LogLevel.WARN, category, message, data);
  }
  
  // Error level log
  public error(category: string, message: string, data?: any) {
    this.log(LogLevel.ERROR, category, message, data);
  }
  
  // Flush logs to a file
  public flush() {
    if (!browser || !this.config.toFile || this.logs.length === 0) return;
    
    try {
      // Create blob with logs
      const logText = this.logs.join('\n') + '\n';
      const blob = new Blob([logText], { type: 'text/plain' });
      
      // Store in localStorage to persist across page loads
      this.appendToLocalStorage(logText);
      
      // Reset logs and last flush time
      this.logs = [];
      this.lastFlush = Date.now();
    } catch (e) {
      originalConsole.error('Error flushing logs:', e);
    }
  }
  
  // Save logs to downloadable file
  public saveToFile(additionalName = '') {
    if (!browser) return;
    
    try {
      // Flush any pending logs
      this.flush();
      
      // Get full logs from localStorage
      const fullLogs = this.getLogsFromLocalStorage();
      
      // Create blob with full logs
      const blob = new Blob([fullLogs], { type: 'text/plain' });
      
      // Create download link
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const fileName = additionalName ? 
        `${this.config.fileName}-${this.logType}-${additionalName}.txt` : 
        `${this.config.fileName}-${this.logType}-${this.clientId}.txt`;
      a.download = fileName;
      
      // Trigger download
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      
      return fileName;
    } catch (e) {
      originalConsole.error('Error saving logs to file:', e);
      return null;
    }
  }
  
  // Append logs to localStorage
  private appendToLocalStorage(logText: string) {
    try {
      const storageKey = `webrtc-logs-${this.logType}-${this.clientId}`;
      const existingLogs = localStorage.getItem(storageKey) || '';
      
      // Check if we need to rotate logs (max size reached)
      if (existingLogs.length + logText.length > this.config.maxLogSize) {
        // Keep only the last half to make space
        const halfPoint = Math.floor(existingLogs.length / 2);
        const truncatedLogs = existingLogs.substring(halfPoint);
        localStorage.setItem(storageKey, truncatedLogs + logText);
      } else {
        localStorage.setItem(storageKey, existingLogs + logText);
      }
    } catch (e) {
      originalConsole.error('Error storing logs in localStorage:', e);
    }
  }
  
  // Get all logs from localStorage
  private getLogsFromLocalStorage(): string {
    if (!browser) return '';
    
    try {
      const storageKey = `webrtc-logs-${this.logType}-${this.clientId}`;
      return localStorage.getItem(storageKey) || '';
    } catch (e) {
      originalConsole.error('Error retrieving logs from localStorage:', e);
      return '';
    }
  }
  
  // Display a UI with logs and download button
  public displayLogUI() {
    if (!browser) return;
    
    // Flush any pending logs
    this.flush();
    
    // Create log display dialog
    const dialog = document.createElement('dialog');
    dialog.style.cssText = `
      position: fixed;
      width: 80%;
      max-width: 800px;
      height: 80%;
      max-height: 600px;
      padding: 20px;
      background: #1e2835;
      color: #c5d1dc;
      border: 1px solid #3d4b5c;
      border-radius: 8px;
      font-family: 'Courier New', monospace;
      font-size: 14px;
      z-index: 10000;
      overflow: hidden;
      display: flex;
      flex-direction: column;
    `;
    
    // Add title and controls
    const header = document.createElement('div');
    header.style.cssText = `
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding-bottom: 10px;
      border-bottom: 1px solid #3d4b5c;
      margin-bottom: 10px;
    `;
    
    const title = document.createElement('h3');
    title.textContent = `WebRTC Logs (${this.logType}:${this.clientId})`;
    title.style.margin = '0';
    
    const controls = document.createElement('div');
    
    const downloadBtn = document.createElement('button');
    downloadBtn.textContent = 'Download Logs';
    downloadBtn.style.cssText = `
      padding: 6px 12px;
      background: #3d4b5c;
      color: #c5d1dc;
      border: none;
      border-radius: 4px;
      margin-right: 10px;
      cursor: pointer;
    `;
    downloadBtn.onclick = () => {
      this.saveToFile();
    };
    
    const closeBtn = document.createElement('button');
    closeBtn.textContent = 'Close';
    closeBtn.style.cssText = `
      padding: 6px 12px;
      background: #3d4b5c;
      color: #c5d1dc;
      border: none;
      border-radius: 4px;
      cursor: pointer;
    `;
    closeBtn.onclick = () => {
      dialog.close();
      document.body.removeChild(dialog);
    };
    
    controls.appendChild(downloadBtn);
    controls.appendChild(closeBtn);
    
    header.appendChild(title);
    header.appendChild(controls);
    
    // Add log content area
    const content = document.createElement('div');
    content.style.cssText = `
      flex-grow: 1;
      overflow-y: auto;
      white-space: pre-wrap;
      padding: 10px;
      background: #141a24;
      border-radius: 4px;
      margin-bottom: 10px;
    `;
    
    // Get logs from localStorage
    const logs = this.getLogsFromLocalStorage();
    content.textContent = logs || 'No logs available.';
    
    // Add auto-scroll checkbox
    const autoScrollLabel = document.createElement('label');
    autoScrollLabel.style.cssText = `
      display: flex;
      align-items: center;
      margin-top: 10px;
      font-size: 12px;
      cursor: pointer;
    `;
    
    const autoScrollCheckbox = document.createElement('input');
    autoScrollCheckbox.type = 'checkbox';
    autoScrollCheckbox.checked = true;
    autoScrollCheckbox.style.marginRight = '8px';
    
    autoScrollLabel.appendChild(autoScrollCheckbox);
    autoScrollLabel.appendChild(document.createTextNode('Auto-scroll to new logs'));
    
    // Add all elements to dialog
    dialog.appendChild(header);
    dialog.appendChild(content);
    dialog.appendChild(autoScrollLabel);
    
    // Add to document
    document.body.appendChild(dialog);
    dialog.showModal();
    
    // Set up auto-refresh of logs
    const refreshInterval = setInterval(() => {
      const latestLogs = this.getLogsFromLocalStorage();
      content.textContent = latestLogs || 'No logs available.';
      
      // Auto-scroll to bottom if checked
      if (autoScrollCheckbox.checked) {
        content.scrollTop = content.scrollHeight;
      }
    }, 1000);
    
    // Clean up interval when dialog is closed
    dialog.addEventListener('close', () => {
      clearInterval(refreshInterval);
    });
  }
}

// Create a singleton instance for the application
export const logger = new WebRTCLogger();

// Safe version that doesn't cause recursion
export function logMessage(level: LogLevel, category: string, message: string, data?: any) {
  if (!isLogging) {
    logger.log(level, category, message, data);
  }
}

// Modified console interceptor to use our safer method
let intercepted = false;
export function interceptConsoleLogs() {
  if (!browser || intercepted) return;
  intercepted = true;
  
  // Replace with interceptors that use the safe method
  console.log = function(...args) {
    originalConsole.log.apply(console, args);
    if (!isLogging) {
      logMessage(LogLevel.INFO, 'Console', args[0], args.slice(1).join(' '));
    }
  };
  
  console.info = function(...args) {
    originalConsole.info.apply(console, args);
    if (!isLogging) {
      logMessage(LogLevel.INFO, 'Console', args[0], args.slice(1).join(' '));
    }
  };
  
  console.warn = function(...args) {
    originalConsole.warn.apply(console, args);
    if (!isLogging) {
      logMessage(LogLevel.WARN, 'Console', args[0], args.slice(1).join(' '));
    }
  };
  
  console.error = function(...args) {
    originalConsole.error.apply(console, args);
    if (!isLogging) {
      logMessage(LogLevel.ERROR, 'Console', args[0], args.slice(1).join(' '));
    }
  };
  
  console.debug = function(...args) {
    originalConsole.debug.apply(console, args);
    if (!isLogging) {
      logMessage(LogLevel.DEBUG, 'Console', args[0], args.slice(1).join(' '));
    }
  };
}