import { expect, test } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';

// Два браузери в одній кімнаті: другий бачить рух першого, чат доходить.
// Кімнату створюємо без ворогів і астероїдів, щоб у сцені були лише гравці.

interface RemotePos {
  x: number;
  y: number;
}

/** Позиція ЧУЖОГО корабля у сцені (isMe === false), через вікно налагодження __net. */
async function remoteShipPos(page: Page): Promise<RemotePos | null> {
  return page.evaluate(() => {
    const net = (window as unknown as { __net?: { frame(a: number, b: number): { ships: { isMe: boolean; x: number; y: number }[] } | null } }).__net;
    const scene = net?.frame(1, 0);
    const other = scene?.ships.find((s) => !s.isMe);
    return other ? { x: other.x, y: other.y } : null;
  });
}

async function joinRoom(browser: Browser, name: string, roomId: string): Promise<Page> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto('/');

  await page.fill('#player-name', name);
  // кімната з'являється у списку після опитування /api/rooms
  const radio = page.locator(`input[name="room"][value="${roomId}"]`);
  await radio.waitFor({ state: 'attached', timeout: 15_000 });
  await radio.check();
  await page.click('#join');

  // після join показується гра: з'являється власний корабель у сцені
  await expect
    .poll(async () => page.evaluate(() => Boolean((window as unknown as { __net?: unknown }).__net)), { timeout: 15_000 })
    .toBe(true);
  return page;
}

test('двоє гравців в одній кімнаті: roster, рух, чат', async ({ browser, request }) => {
  // чиста кімната без AI/астероїдів
  const created = await request.post('/api/rooms', {
    data: { name: `E2E ${Date.now()}`, arena: { enemies: 0, asteroids: 0 } },
  });
  expect(created.ok()).toBeTruthy();
  const room = (await created.json()) as { id: string };

  const alice = await joinRoom(browser, 'Alice', room.id);
  const bob = await joinRoom(browser, 'Bob', room.id);

  // 1) обидва бачать одне одного в ростері
  await expect(bob.locator('#roster')).toContainText('Alice', { timeout: 15_000 });
  await expect(alice.locator('#roster')).toContainText('Bob', { timeout: 15_000 });

  // 2) чат доходить від Alice до Bob
  const message = `привіт-${Date.now()}`;
  await alice.fill('#chat-input', message);
  await alice.press('#chat-input', 'Enter');
  await expect(bob.locator('#chat-log')).toContainText(message, { timeout: 15_000 });

  // 3) Bob бачить рух Alice: тримаємо тягу, чужий корабель зсувається
  await bob.bringToFront();
  const before = await remoteShipPos(bob);
  expect(before, 'Bob має бачити корабель Alice').not.toBeNull();

  await alice.bringToFront();
  await alice.locator('#gameCanvas').click({ position: { x: 10, y: 10 } }).catch(() => {});
  await alice.keyboard.down('ArrowUp');
  await alice.waitForTimeout(1500);
  await alice.keyboard.up('ArrowUp');

  await expect
    .poll(
      async () => {
        const now = await remoteShipPos(bob);
        if (!now || !before) return 0;
        return Math.hypot(now.x - before.x, now.y - before.y);
      },
      { timeout: 10_000, message: 'корабель Alice має зсунутись у Bob на екрані' },
    )
    .toBeGreaterThan(5);

  await alice.context().close();
  await bob.context().close();
});
