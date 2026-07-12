/**
 * localStorage keys and defaults for Unity diff preferences that need to be
 * read from both the diff pane (Diff, UnityDiff) and the surrounding
 * changes/history panes (which own the state passed down to DiffOptions).
 * Kept in one place so the key strings can't drift between the two ends.
 */

import { getBoolean, setBoolean } from '../../lib/local-storage'

export const unityShowUnchangedKey = 'unity-diff-show-unchanged'
export const unityAlwaysOpenLargeKey = 'unity-diff-always-open-large'
export const unityHideFloatDriftKey = 'unity-diff-hide-float-drift'

export const readUnityHideFloatDrift = (): boolean =>
  getBoolean(unityHideFloatDriftKey, true)

export const writeUnityHideFloatDrift = (value: boolean): void =>
  setBoolean(unityHideFloatDriftKey, value)
