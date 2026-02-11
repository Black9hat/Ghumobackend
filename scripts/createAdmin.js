// createAdmin.js
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';

dotenv.config();

const createAdmin = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log('✅ Connected to database');

    const AdminSchema = new mongoose.Schema({
      email: String,
      password: String,
      name: String,
      role: { type: String, default: 'admin' },
      isActive: { type: Boolean, default: true },
      createdAt: { type: Date, default: Date.now }
    });

    const Admin = mongoose.models.Admin || mongoose.model('Admin', AdminSchema);

    const existingAdmin = await Admin.findOne({ email: 'admin@goindia.com' });
    if (existingAdmin) {
      console.log('⚠️ Admin already exists!');
      process.exit(0);
    }

    const hashedPassword = await bcrypt.hash('Admin@123', 10);

    await Admin.create({
      email: 'admin@goindia.com',
      password: hashedPassword,
      name: 'Super Admin'
    });

    console.log('');
    console.log('='.repeat(50));
    console.log('✅ Admin created successfully!');
    console.log('');
    console.log('📧 Email: admin@goindia.com');
    console.log('🔑 Password: Admin@123');
    console.log('');
    console.log('⚠️  Change password after first login!');
    console.log('='.repeat(50));

    process.exit(0);
  } catch (error) {
    console.error('❌ Error:', error);
    process.exit(1);
  }
};

createAdmin();
