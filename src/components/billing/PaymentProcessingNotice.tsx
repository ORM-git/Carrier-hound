'use client';
import React, {useState} from 'react';
export interface PendingPayment { orderId: string; paymentId: string; retry: () => Promise<void> }
export default function PaymentProcessingNotice({payment}: {payment: PendingPayment}) {
  const [checking,setChecking]=useState(false);
  const check=async()=>{if(checking)return;setChecking(true);try{await payment.retry()}catch{/* Keep unresolved status, never initiate another charge. */}finally{setChecking(false)}};
  return <section role="status" aria-label="Payment processing" className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-slate-800 space-y-3 break-words">
    <h2 className="font-bold">Payment confirmation pending</h2>
    <p>Your payment has not been confirmed yet. Do not pay again while we check. Access is added only after payment is confirmed.</p>
    <p>If you were debited, keep your payment reference. You can check the same payment again without making another charge.</p>
    <p className="text-xs break-all">Order: {payment.orderId}<br/>Payment: {payment.paymentId}</p>
    <div className="flex flex-wrap items-center gap-3"><button type="button" disabled={checking} onClick={check} className="rounded-lg bg-blue-600 px-4 py-3 text-white font-semibold disabled:opacity-50">{checking?'Checking payment...':'Check payment status'}</button><a className="underline" href="/settings?tab=billing">Payment history</a></div>
    <p className="text-xs">If confirmation is still pending, contact <a className="underline" href="mailto:support@careermonke.com">support@careermonke.com</a> with these references. This page does not retry the charge.</p>
  </section>;
}
