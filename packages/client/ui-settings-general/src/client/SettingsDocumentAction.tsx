/** Optional settings-header action for opening a file-backed Host document. */

import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { Button, Modal, writeClipboard } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SettingsDocumentStore } from './settings-document-store.ts'
import css from './SettingsDocumentAction.module.css'

/** Registrant-owned dependencies of {@link SettingsDocumentAction}. */
export interface SettingsDocumentActionInjected {
  /** Provider metadata and action state owner. */
  controller: SettingsDocumentStore
  hooks: {
    /** Controller snapshot bound by the UI renderer as useSnapshot. */
    snapshot: SettingsDocumentStore['store']
  }
}

/** Header-action owner share, localized copy, and the registrant's state face. */
export type SettingsDocumentActionProps =
  PropsRuntime<'settings.action'> & PropsLocale<'settings'> & InjectFace<SettingsDocumentActionInjected>

/**
 * Render the open-document action only after Host metadata confirms document availability.
 *
 * A Host with no native opener answers the gesture with the provider-owned path
 * instead of failing it; the action then shows that path in a dialog so the
 * user can open it with an editor of their own.
 * @param props - header owner props, localized copy, and injected document state.
 * @returns the action, or null while unavailable or unresolved.
 */
export function SettingsDocumentAction({ controller, useSnapshot, t }: SettingsDocumentActionProps): ReactNode {
  const state = useSnapshot(snapshot => snapshot)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    void controller.load()
  }, [controller])

  useEffect(() => {
    if (state.revealedPath === null) setCopied(false)
  }, [state.revealedPath])

  if (state.status !== 'ready') return null

  const revealedPath = state.revealedPath

  return (
    <div className={css.action}>
      {state.error === null ? null : <span className={css.error} role="alert">{t('openDocument.error')}</span>}
      <Button
        variant="outline"
        size="sm"
        disabled={state.opening}
        onClick={() => { void controller.open() }}
      >
        {t('openDocument')}
      </Button>
      <Modal
        open={revealedPath !== null}
        onClose={() => { controller.dismissPath() }}
        title={t('openDocument.pathTitle')}
        closeLabel={t('close')}
        description={t('openDocument.pathHint')}
        footer={(
          <>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                if (revealedPath === null) return
                void writeClipboard(revealedPath).then((ok) => { setCopied(ok) })
              }}
            >
              {copied ? t('openDocument.copied') : t('openDocument.copyPath')}
            </Button>
            <Button variant="primary" size="sm" onClick={() => { controller.dismissPath() }}>
              {t('close')}
            </Button>
          </>
        )}
      >
        <code className={css.path}>{revealedPath ?? ''}</code>
      </Modal>
    </div>
  )
}
