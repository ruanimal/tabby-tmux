import { Injectable } from '@angular/core'
import { Observable, Subject } from 'rxjs'

/**
 * Notifies live tmux tabs after a setting is changed in the plugin settings UI.
 *
 * The installed Tabby ConfigService exposes a mutable store but no public
 * configuration-change observable that plugins can subscribe to, so this
 * service keeps the notification boundary inside the plugin.
 */
@Injectable({ providedIn: 'root' })
export class TmuxConfigChangeService {
    private readonly changes = new Subject<void>()
    readonly changed$: Observable<void> = this.changes.asObservable()

    notifyChanged(): void {
        this.changes.next()
    }
}
