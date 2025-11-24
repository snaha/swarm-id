import { test, expect } from '@playwright/experimental-ct-svelte'
import Checkbox from './checkbox.svelte'

test.describe('Checkbox Component', () => {
	test('should render with default props', async ({ mount }) => {
		const component = await mount(Checkbox)
		const checkbox = component.locator('input[type="checkbox"]')

		await expect(checkbox).toBeVisible()
		await expect(checkbox).not.toBeChecked()
		await expect(checkbox).not.toBeDisabled()
	})

	test('should render as checked when checked prop is true', async ({ mount }) => {
		const component = await mount(Checkbox, {
			props: { checked: true },
		})
		const checkbox = component.locator('input[type="checkbox"]')

		await expect(checkbox).toBeChecked()
	})

	test('should render as disabled when disabled prop is true', async ({ mount }) => {
		const component = await mount(Checkbox, {
			props: { disabled: true },
		})
		const checkbox = component.locator('input[type="checkbox"]')

		await expect(checkbox).toBeDisabled()
	})

	test('should support different dimensions', async ({ mount }) => {
		const dimensions = ['default', 'large', 'compact', 'small'] as const

		for (const dimension of dimensions) {
			const component = await mount(Checkbox, {
				props: { dimension },
			})
			const checkbox = component.locator('input[type="checkbox"]')

			// Verify component renders correctly with different dimensions
			await expect(checkbox).toBeVisible()
			await component.unmount()
		}
	})

	test('should handle click to toggle checked state', async ({ mount }) => {
		const component = await mount(Checkbox)
		const checkbox = component.locator('input[type="checkbox"]')

		// Initially unchecked
		await expect(checkbox).not.toBeChecked()

		// Click to check
		await checkbox.click()
		await expect(checkbox).toBeChecked()

		// Click to uncheck
		await checkbox.click()
		await expect(checkbox).not.toBeChecked()
	})

	test('should handle keyboard navigation', async ({ mount }) => {
		const component = await mount(Checkbox)
		const checkbox = component.locator('input[type="checkbox"]')

		// Focus the checkbox
		await checkbox.focus()
		await expect(checkbox).toBeFocused()

		// Toggle with space key
		await expect(checkbox).not.toBeChecked()
		await checkbox.press('Space')
		await expect(checkbox).toBeChecked()

		// Toggle again with space key
		await checkbox.press('Space')
		await expect(checkbox).not.toBeChecked()
	})

	test('should not be clickable when disabled', async ({ mount }) => {
		const component = await mount(Checkbox, {
			props: { disabled: true, checked: false },
		})
		const checkbox = component.locator('input[type="checkbox"]')

		await expect(checkbox).toBeDisabled()
		await expect(checkbox).not.toBeChecked()

		// Try to click (should have no effect)
		await checkbox.click({ force: true })
		await expect(checkbox).not.toBeChecked()
	})

	test('should support custom HTML attributes', async ({ mount }) => {
		const component = await mount(Checkbox, {
			props: {
				id: 'test-checkbox',
				name: 'test-name',
				value: 'test-value',
				'data-testid': 'custom-checkbox',
			},
		})
		const checkbox = component.locator('input[type="checkbox"]')

		await expect(checkbox).toHaveAttribute('id', 'test-checkbox')
		await expect(checkbox).toHaveAttribute('name', 'test-name')
		await expect(checkbox).toHaveAttribute('value', 'test-value')
		await expect(checkbox).toHaveAttribute('data-testid', 'custom-checkbox')
	})

	test('should work with form submission', async ({ mount }) => {
		const component = await mount(Checkbox, {
			props: {
				name: 'newsletter',
				value: 'subscribe',
			},
		})
		const checkbox = component.locator('input[type="checkbox"]')

		// Check the checkbox
		await checkbox.click()
		await expect(checkbox).toBeChecked()
		await expect(checkbox).toHaveAttribute('name', 'newsletter')
		await expect(checkbox).toHaveAttribute('value', 'subscribe')
	})

	test('should handle rapid state changes', async ({ mount }) => {
		const component = await mount(Checkbox)
		const checkbox = component.locator('input[type="checkbox"]')

		// Perform rapid clicks
		for (let i = 0; i < 5; i++) {
			await checkbox.click()
		}

		// Should end up checked (odd number of clicks)
		await expect(checkbox).toBeChecked()
	})

	test('should work as standalone checkbox', async ({ mount }) => {
		const component = await mount(Checkbox, {
			props: { id: 'standalone-checkbox' },
		})
		const checkbox = component.locator('input[type="checkbox"]')

		await expect(checkbox).toBeVisible()
		await expect(checkbox).toHaveAttribute('id', 'standalone-checkbox')
	})

	test('should support indeterminate state', async ({ mount }) => {
		const component = await mount(Checkbox)
		const checkbox = component.locator('input[type="checkbox"]')

		// Set indeterminate state programmatically
		await checkbox.evaluate((el) => {
			;(el as HTMLInputElement).indeterminate = true
		})

		// Verify indeterminate state
		const isIndeterminate = await checkbox.evaluate((el) => (el as HTMLInputElement).indeterminate)
		expect(isIndeterminate).toBe(true)
	})

	test('should handle focus and blur events', async ({ mount }) => {
		const component = await mount(Checkbox)
		const checkbox = component.locator('input[type="checkbox"]')

		// Focus the checkbox
		await checkbox.focus()
		await expect(checkbox).toBeFocused()

		// Blur the checkbox
		await checkbox.blur()
		await expect(checkbox).not.toBeFocused()
	})

	test('should work with checked and disabled combination', async ({ mount }) => {
		const component = await mount(Checkbox, {
			props: { checked: true, disabled: true },
		})
		const checkbox = component.locator('input[type="checkbox"]')

		await expect(checkbox).toBeChecked()
		await expect(checkbox).toBeDisabled()

		// Try to click (should have no effect)
		await checkbox.click({ force: true })
		await expect(checkbox).toBeChecked() // Should remain checked
	})

	test('should verify component renders across different states', async ({ mount }) => {
		const states = [
			{ props: { hover: true } },
			{ props: { active: true } },
			{ props: { focus: true } },
			{ props: { class: 'custom-class' } },
		]

		for (const state of states) {
			const component = await mount(Checkbox, state)
			const checkbox = component.locator('input[type="checkbox"]')

			// Verify component renders and functions properly
			await expect(checkbox).toBeVisible()
			await checkbox.click()
			await expect(checkbox).toBeChecked()

			await component.unmount()
		}
	})
})
