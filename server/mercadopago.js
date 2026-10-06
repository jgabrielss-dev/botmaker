const BASE = 'https://api.mercadopago.com';

function token() {
  const t = process.env.MERCADO_PAGO_ACCESS_TOKEN;
  if (!t || t.includes('[cole aqui]')) throw new Error('MERCADO_PAGO_ACCESS_TOKEN nao configurado');
  return t;
}

async function createPixPayment({ amount, description, externalReference, notificationUrl }) {
  const body = {
    transaction_amount: Number(amount),
    description: description || 'Pagamento Pix',
    payment_method_id: 'pix',
    external_reference: externalReference || '',
    notification_url: notificationUrl || undefined,
    payer: { email: 'cliente@exemplo.com' }
  };
  const res = await fetch(`${BASE}/v1/payments`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json', 'X-Idempotency-Key': externalReference + '-' + Date.now() },
    body: JSON.stringify(body)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error('Mercado Pago: ' + (data.message || res.status) + ' ' + JSON.stringify(data.cause || ''));
  }
  const tx = (data.point_of_interaction && data.point_of_interaction.transaction_data) || {};
  return {
    mpId: String(data.id),
    status: data.status,
    amount: Number(data.transaction_amount || amount),
    qrCode: tx.qr_code || '',
    qrBase64: tx.qr_code_base64 || '',
    ticketUrl: tx.ticket_url || ''
  };
}

async function getPayment(id) {
  const res = await fetch(`${BASE}/v1/payments/${id}`, {
    headers: { Authorization: `Bearer ${token()}` }
  });
  if (!res.ok) return null;
  return res.json();
}

module.exports = { createPixPayment, getPayment };
