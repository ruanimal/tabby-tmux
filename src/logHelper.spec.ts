import { describe, expect, it, vi } from 'vitest'
import type { ConfigService, Logger } from 'tabby-core'
import { createConditionalLogger } from './logHelper'

function createLoggerMock() {
    return {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
    } as unknown as Logger
}

function createConfigService(debugLogging: boolean) {
    return {
        store: { tmuxPlugin: { debugLogging } },
    } as unknown as ConfigService
}

describe('createConditionalLogger', () => {
    it('forwards debug/info when debugLogging is enabled', () => {
        const logger = createLoggerMock()
        const log = createConditionalLogger(logger, createConfigService(true))
        log.debug('d', 1)
        log.info('i', 2)
        expect(logger.debug).toHaveBeenCalledWith('d', 1)
        expect(logger.info).toHaveBeenCalledWith('i', 2)
    })

    it('suppresses debug/info when debugLogging is disabled', () => {
        const logger = createLoggerMock()
        const log = createConditionalLogger(logger, createConfigService(false))
        log.debug('d')
        log.info('i')
        expect(logger.debug).not.toHaveBeenCalled()
        expect(logger.info).not.toHaveBeenCalled()
    })

    it('always forwards warn/error regardless of debugLogging', () => {
        const logger = createLoggerMock()
        const log = createConditionalLogger(logger, createConfigService(false))
        log.warn('w')
        log.error('e')
        expect(logger.warn).toHaveBeenCalledWith('w')
        expect(logger.error).toHaveBeenCalledWith('e')
    })

    it('suppresses debug/info when no configService is provided', () => {
        const logger = createLoggerMock()
        const log = createConditionalLogger(logger)
        log.debug('d')
        log.info('i')
        log.warn('w')
        log.error('e')
        expect(logger.debug).not.toHaveBeenCalled()
        expect(logger.info).not.toHaveBeenCalled()
        expect(logger.warn).toHaveBeenCalledWith('w')
        expect(logger.error).toHaveBeenCalledWith('e')
    })
})
