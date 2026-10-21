import { expect, test } from '@playwright/test'
import { primary } from '../fixtures/accounts'
import { makeFiles } from '../fixtures/files'
import { createProject, dropFiles, openUploads, resetUploads, rows, signIn } from '../fixtures/stack'

test('a dropped 3 MB file uploads and shows up as one asset', async ({ page }, testInfo) => {
  const account = await primary()
  const stamp = `${Date.now()}`
  const name = `smoke-${stamp}`

  await signIn(page, account)
  await resetUploads(page)
  const project = await createProject(account, `E2E smoke ${stamp}`)
  // A PNG, so the transcoder can read it and the row finishes instead of
  // sitting in "Processing" (see makeFiles).
  const [file] = await makeFiles(testInfo.outputPath('files'), [{ name: `${name}.png`, bytes: 3 * 1024 * 1024 }])

  await page.goto(`/projects/${project.id}`)
  await expect(page.getByText('No assets')).toBeVisible()
  await dropFiles(page, 'project', [file])

  await openUploads(page)
  const statusOfRow = async () => (await rows(page)).find((r) => r.name === name)?.status
  // "Ready" is what a finished row says today; "Processing" is the step before.
  await expect.poll(statusOfRow, { timeout: 90_000 }).toMatch(/^(Ready|Complete|Processing)$/)

  // One asset, and the empty state is gone. The grid refetches on its own once
  // the row is Ready, so this also waits out the processing.
  await expect(page.getByRole('button', { name: `${name} menu` })).toHaveCount(1, { timeout: 60_000 })
  await expect(page.getByText('No assets')).toHaveCount(0)
})
