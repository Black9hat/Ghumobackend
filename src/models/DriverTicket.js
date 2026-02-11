import mongoose from 'mongoose';

const driverTicketSchema = new mongoose.Schema({
  driverId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  driverName: String,
  driverPhone: String,
  issueType: {
    type: String,
    enum: ['app_issue', 'payment_issue', 'trip_issue', 'account_issue', 
           'documents_issue', 'wallet_issue', 'commission_issue', 'other'],
    required: true
  },
  message: String,
  priority: {
    type: String,
    enum: ['low', 'medium', 'high', 'critical'],
    default: 'medium'
  },
  status: {
    type: String,
    enum: ['pending', 'in_progress', 'resolved'],
    default: 'pending'
  },
  adminNotes: String,
  resolvedAt: Date
}, { timestamps: true });

export default mongoose.model('DriverTicket', driverTicketSchema);