# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build/Run Commands
- `npm run dev` - Start development server
- `npm run build` - Build for production
- `npm run deploy` - Build and deploy to Firebase
- `npm run preview` - Preview production build locally
- `npm run check` - Type check the codebase
- `npm run check:watch` - Watch mode for type checking

## Code Style Guidelines
- **Imports**: Group imports by source (Svelte, Firebase, custom lib)
- **Formatting**: Use spaces for indentation, trailing commas in objects
- **Types**: Use TypeScript strict mode, prefer explicit return types
- **Naming**: camelCase for variables/functions, PascalCase for components
- **Components**: Svelte 5 components, use $lib path alias for imports
- **Store Pattern**: Use Svelte writable/readable stores for state management
- **Firebase**: Access Firebase services through lib/firebase.ts exports
- **Error Handling**: Use try/catch for async operations, provide helpful errors
- **Comments**: Minimal but useful comments for complex logic