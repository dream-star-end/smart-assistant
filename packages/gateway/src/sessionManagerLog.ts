/**
 * The sessionManager module logger, shared by sessionManager.ts and the modules split out of it
 * (sessionTurnRunner.ts …) so their log lines keep the same `module: 'sessionManager'` tag.
 */
import { createLogger } from './logger.js'

export const log = createLogger({ module: 'sessionManager' })
