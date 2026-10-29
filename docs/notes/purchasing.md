# Buying: requisition, order, delivery

- **Purchase paperwork is one chain, not four menus** (P6). Requisition → purchase order
  → receiving against it. Approve, send, cancel and close are buttons on the document
  (`set_po_status()`), not BMS's separate approve and cancel menus, so a decision
  happens where the thing being decided is visible. `receive_against_po()` delegates
  the goods to P5's `receive_goods()`, so there is still ONE path that moves stock,
  writes serials and moves the average cost. Prices come off the order; a manager may
  override one and both figures are logged, because an order whose agreed price is
  quietly ignored is decoration. An order over `shops.po_approval_limit` goes to
  `awaiting_approval` instead of out. Supplier payments are applied **oldest first** in
  `supplier_aging()`, which is what a supplier assumes — newest-first would keep the
  oldest invoice perpetually overdue while the shop paid steadily.
