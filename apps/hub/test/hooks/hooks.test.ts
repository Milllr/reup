import { describe, expect, it } from 'vitest';
import { DEVICE, rig, toAwaiting } from '../helpers';

const SECRET = { 'X-Offcut-Secret': 'dev-supply-secret' };

async function placed() {
  const r = await rig();
  const id = await toAwaiting(r);
  await r.call('POST', `/api/orders/${id}/approve`, { by: 'button' }, DEVICE);
  await r.call('POST', '/ingest/placed', { jobId: 'j', orderId: id, ok: true, confirmation: 'OC-58213', eta: null, error: null }, DEVICE);
  return { r, id };
}

describe("the store's webhook", () => {
  it('confirmed keeps placed and sets the eta; shipped ships; delivered says so; a repeat is harmless', async () => {
    const { r, id } = await placed();
    const hook = (event: string, eta: string | null = '2026-11-24T17:00:00-05:00') => r.call('POST', '/hooks/supply', { event, confirmation: 'OC-58213', poNumber: 'RU-1042', eta }, undefined, SECRET);
    expect((await hook('order.confirmed')).status).toBe(200);
    expect(r.room.order(id)).toMatchObject({ state: 'placed', eta: '2026-11-24T17:00:00-05:00' });
    await hook('order.shipped');
    await hook('order.shipped');
    expect(r.room.order(id)?.state).toBe('shipped');
    expect(r.room.s.activity.filter((a) => a.text === 'Offcut Supply shipped order RU-1042. Arrives Tuesday.')).toHaveLength(1);
    await hook('order.delivered');
    expect(r.room.s.activity.at(-1)?.text).toBe('Offcut Supply says order RU-1042 was delivered.');
    expect(r.room.order(id)?.state).toBe('shipped');
  });

  it("stands in for the buyer's report when the store confirms first", async () => {
    const r = await rig();
    const id = await toAwaiting(r);
    await r.call('POST', `/api/orders/${id}/approve`, { by: 'phone' }, 'dev-approve-key');
    await r.call('POST', '/hooks/supply', { event: 'order.confirmed', confirmation: 'OC-7', poNumber: 'RU-1042', eta: null }, undefined, SECRET);
    expect(r.room.order(id)).toMatchObject({ state: 'placed', confirmation: 'OC-7' });
    // The buyer's own report arriving late changes nothing.
    await r.call('POST', '/ingest/placed', { jobId: 'j', orderId: id, ok: true, confirmation: 'OC-7', eta: null, error: null }, DEVICE);
    expect(r.room.order(id)?.state).toBe('placed');
  });

  it('answers 401 for a wrong secret and 404 for an unknown PO number', async () => {
    const { r } = await placed();
    const body = { event: 'order.shipped', confirmation: 'OC-58213', poNumber: 'RU-1042', eta: null };
    expect((await r.call('POST', '/hooks/supply', body, undefined, { 'X-Offcut-Secret': 'nope' })).status).toBe(401);
    expect((await r.call('POST', '/hooks/supply', body)).status).toBe(401);
    expect((await r.call('POST', '/hooks/supply', { ...body, poNumber: 'RU-9' }, undefined, SECRET)).status).toBe(404);
  });
});
