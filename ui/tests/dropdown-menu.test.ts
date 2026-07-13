// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { expect, test } from '@playwright/test'

// The account chooser (`/?signin`) renders the settings menu without needing
// an account — the cheapest real mount of the shared DropdownMenu. These tests
// pin the dismissal contract every menu call site inherits: the trigger
// toggles, outside pointerdown closes, Escape closes, items close on activate,
// and arrow keys rove focus.

test.beforeEach(async ({ page }) => {
  await page.goto('/?signin')
})

test('trigger toggles the menu open and closed', async ({ page }) => {
  const trigger = page.getByRole('button', { name: 'Settings' })
  const menu = page.getByRole('menu')

  await expect(menu).toBeHidden()
  await trigger.click()
  await expect(menu).toBeVisible()
  await expect(page.getByRole('menuitem', { name: 'Network settings' })).toBeVisible()

  await trigger.click()
  await expect(menu).toBeHidden()
})

test('pointerdown outside closes the menu', async ({ page }) => {
  await page.getByRole('button', { name: 'Settings' }).click()
  await expect(page.getByRole('menu')).toBeVisible()

  await page.mouse.click(10, 10)
  await expect(page.getByRole('menu')).toBeHidden()
})

test('Escape closes the menu and returns focus to the trigger', async ({ page }) => {
  const trigger = page.getByRole('button', { name: 'Settings' })
  await trigger.click()
  await expect(page.getByRole('menu')).toBeVisible()

  await page.keyboard.press('Escape')
  await expect(page.getByRole('menu')).toBeHidden()
  await expect(trigger).toBeFocused()
})

test('arrow keys rove focus across menu items, wrapping at the ends', async ({ page }) => {
  await page.getByRole('button', { name: 'Settings' }).click()

  await page.keyboard.press('ArrowDown')
  await expect(page.getByRole('menuitem', { name: 'Network settings' })).toBeFocused()

  await page.keyboard.press('ArrowDown')
  await expect(page.getByRole('menuitem', { name: 'Restore account from backup' })).toBeFocused()

  await page.keyboard.press('ArrowUp')
  await expect(page.getByRole('menuitem', { name: 'Network settings' })).toBeFocused()

  // Wraps from the first item to the last (the Dark appearance radio).
  await page.keyboard.press('ArrowUp')
  await expect(page.getByRole('menuitemradio', { name: 'Dark' })).toBeFocused()
})

test('activating an item closes the menu', async ({ page }) => {
  await page.getByRole('button', { name: 'Settings' }).click()
  await page.getByRole('menuitem', { name: 'Network settings' }).click()

  await expect(page.getByRole('menu')).toBeHidden()
  await expect(page.getByRole('dialog', { name: 'Network settings' })).toBeVisible()
})
