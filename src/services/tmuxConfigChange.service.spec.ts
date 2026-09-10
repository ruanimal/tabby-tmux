import { describe, expect, it } from 'vitest'
import { TmuxConfigChangeService } from './tmuxConfigChange.service'

describe('TmuxConfigChangeService', () => {
    it('notifies subscribers when configuration is saved', () => {
        const service = new TmuxConfigChangeService()
        let notifications = 0
        service.changed$.subscribe(() => notifications++)

        service.notifyChanged()
        service.notifyChanged()

        expect(notifications).toBe(2)
    })
})
