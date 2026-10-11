const { addTable } = require('../../utils');

module.exports = addTable('machine_payment_events', {
  id: { type: 'string', maxlength: 24, nullable: false, primary: true },
  post_id: {
    type: 'string',
    maxlength: 24,
    nullable: false,
    references: 'posts.id',
    cascadeDelete: true,
  },
  amount: { type: 'integer', nullable: false },
  currency: { type: 'string', maxlength: 50, nullable: false },
  protocol: { type: 'string', maxlength: 50, nullable: false },
  method: { type: 'string', maxlength: 50, nullable: false },
  stripe_payment_intent_id: { type: 'string', maxlength: 255, nullable: true, unique: true },
  reference: { type: 'string', maxlength: 255, nullable: false },
  created_at: { type: 'dateTime', nullable: false },
  '@@UNIQUE_CONSTRAINTS@@': [['protocol', 'reference']],
});
