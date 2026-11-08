# GST invoice builder (Backend sheet row: GST Invoicing)

Status: pure library plus offline test. Not wired to any route, checkout, webhook or table.
Nothing calls it, so no behavior changes. Payments stay off.

Pieces: `src/lib/billing/gstInvoice.ts` (pure logic), `scripts/test-gst-invoice.ts` (offline, registered).

## What it does

`buildGstInvoice(input)` returns either `{ ok: true, invoice }` or `{ ok: false, errors }`.

- Money is integer paise only.
- Intra-state supply (seller and buyer state codes equal) gives CGST + SGST. Inter-state gives IGST.
  CGST + SGST always equals the line tax exactly (SGST takes the odd paisa).
- Tax-extra mode: tax = round-half-up(taxable x rate). Tax-inclusive mode: taxable is back-calculated
  and tax is the remainder, so the total equals the listed amount.
- Invoice number: `PREFIX/FYFY/000001`, at most 16 characters, letters, digits, `/` and `-`, which are
  the GST invoice-number limits as understood here (owner and accountant to confirm). Fiscal year is
  April to March in IST. The caller owns the sequence; the builder never generates one.
- Structural checks only: GSTIN shape (15 characters, no checksum), two-digit state code, 4 to 8 digit SAC.

## Required arguments (no defaults, owner to confirm each)

| Argument | Why there is no default |
| --- | --- |
| `lines[].rateBps` | Tax rate per supply is the owner's and accountant's call |
| `lines[].sacCode` | Classification of the service |
| `pricesIncludeTax` | Whether listed prices already contain GST is a pricing decision |
| `seller` name, GSTIN, state code | Legal identity of the supplier |
| `invoicePrefix`, `invoiceSequence` | Numbering series must be gap-free and owned by one counter |

## What it does NOT do (unproven or owner work)

- No PDF, email or storage of invoices. No table, so no migration. No link to orders or payments.
- No place-of-supply rules beyond comparing two state codes (no export, SEZ, reverse charge, composition
  scheme, credit notes, e-invoicing IRN or e-way bill).
- No GSTIN checksum or live GSTIN lookup.
- Rounding is per line, round half up. Whether the accountant wants per-line or per-invoice rounding
  is open (owner to confirm).
- Never run against real orders. The row stays not-done until the owner supplies GSTIN, rates, SAC code and
  numbering series, an accountant signs off, and a wiring change is approved (payments are off).

## Owner steps (for the keeper's Doc)

1. Provide GSTIN, legal name, registered state code, SAC code and the GST rate for each plan.
2. Say whether listed plan prices include GST.
3. Choose the invoice prefix and who owns the sequence counter.
4. Accountant review of rounding and invoice fields.
5. Approve wiring to billing later, together with the decision to turn payments on.
