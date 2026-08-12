import { Logger, ConfigService } from 'tabby-core'

export interface ConditionalLogger {
    debug: (...args: any[]) => void
    info: (...args: any[]) => void
    warn: (...args: any[]) => void
    error: (...args: any[]) => void
}

/**
 * Wrap a Logger so that debug/info are gated behind debugLogging config,
 * while warn/error always pass through.
 */
export function createConditionalLogger(
    logger: Logger,
    configService?: ConfigService,
): ConditionalLogger {
    return {
        debug: (...args: any[]) => {
            if (configService?.store?.tmuxPlugin?.debugLogging) logger.debug(...args)
        },
        info: (...args: any[]) => {
            if (configService?.store?.tmuxPlugin?.debugLogging) logger.info(...args)
        },
        warn: logger.warn.bind(logger),
        error: logger.error.bind(logger),
    }
}
