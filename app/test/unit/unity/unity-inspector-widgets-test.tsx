import assert from 'node:assert'
import { describe, it } from 'node:test'
import * as React from 'react'

import { CollapsibleArray } from '../../../src/ui/diff/unity/unity-inspector-widgets'
import { fireEvent, render, screen } from '../../helpers/ui/render'

describe('CollapsibleArray', () => {
  it('折りたたみ中も変更状態を見出しに表示する', () => {
    const view = render(
      <CollapsibleArray
        summary="[3 of 20 changed]"
        defaultExpanded={false}
        status="modified"
      >
        <span>変更された要素</span>
      </CollapsibleArray>
    )
    const header = screen.getByRole('button', { name: /3 of 20 changed/ })

    assert.equal(header.classList.contains('unity-status-modified'), true)
    assert.equal(header.getAttribute('aria-expanded'), 'false')
    assert.equal(view.queryByText('変更された要素'), null)

    fireEvent.click(header)

    assert.equal(header.getAttribute('aria-expanded'), 'true')
    assert.notEqual(screen.getByText('変更された要素'), null)
  })
})
