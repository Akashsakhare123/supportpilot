import { expect, test } from '@playwright/test';

/**
 * The whole product in one run: a business signs up, adds a help article, a customer asks the
 * widget and gets an AI answer from that article, asks for a person, and an agent replies live.
 */
test('signup -> upload doc -> ask in widget -> handoff -> agent reply', async ({
  page,
  browser,
}) => {
  const run = Date.now().toString(36);
  const company = `E2E Cycles ${run}`;

  // 1. Signup and onboarding (the widget key comes from the "Preview on a demo page" link).
  await page.goto('/signup');
  await page.getByLabel('Company name').fill(company);
  await page.getByLabel('Your name').fill('Erin Example');
  await page.getByLabel('Work email').fill(`owner+${run}@e2e.test`);
  await page.getByLabel('Password (8+ characters)').fill('Correct-horse-42');
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await expect(page).toHaveURL(/\/app\/onboarding/);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: 'Continue' }).click();
  const tryUrl = await page
    .getByRole('link', { name: 'Preview on a demo page' })
    .getAttribute('href');
  expect(tryUrl).toMatch(/try\.html\?key=pk_/);
  await page.getByRole('button', { name: 'Finish setup' }).click();
  await expect(page).toHaveURL(/\/app$/);

  // 2. Upload a help article and wait until the worker has embedded it.
  await page.goto('/app/knowledge');
  await page.locator('input[type="file"]').setInputFiles({
    name: 'Bluefin Rewards.md',
    mimeType: 'text/markdown',
    buffer: Buffer.from(
      '# Bluefin Rewards\n\nBluefin Rewards members get free shipping on every order and early access to sales.\n',
    ),
  });
  await expect(page.getByRole('row', { name: /Bluefin Rewards/ })).toContainText('Ready', {
    timeout: 60_000,
  });

  // The agent (the owner) keeps the inbox open, so they are online for the hand-off.
  await page.goto('/app/inbox');
  await expect(page.getByRole('tab', { name: /Needs agent/ })).toBeVisible();

  // 3. A customer on the business's website asks the widget.
  const customer = await (await browser.newContext()).newPage();
  await customer.goto(tryUrl!);
  await customer.getByRole('button', { name: 'Open support chat' }).click();
  const chat = customer.getByRole('dialog');
  await chat.getByLabel('Message').fill('What do Bluefin Rewards members get?');
  await chat.getByLabel('Message').press('Enter');
  await expect(chat).toContainText('free shipping on every order');
  await expect(chat).toContainText('Bluefin Rewards'); // the cited source

  // 4. Hand-off: the customer asks for a person; the conversation shows up live for the agent.
  await chat.getByRole('button', { name: 'Talk to a person' }).click();
  await expect(chat).toContainText(/connecting you|team will reply/i);
  await page.getByRole('tab', { name: /Needs agent/ }).click();
  await page.locator('ul li button').first().click();
  await page.getByRole('button', { name: 'Take conversation' }).click();

  // 5. The agent's reply reaches the widget in real time.
  await page.getByLabel('Reply').fill('Hi! Erin here. Happy to help with your rewards.');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(chat).toContainText('Happy to help with your rewards');
});
