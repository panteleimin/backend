const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs'); 
const cron = require('node-cron');
const cloudinary = require('cloudinary').v2; 
require('dotenv').config();

const app = express();

app.use(cors({ origin: '*' }));
app.use(express.json());


cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});


if (!fs.existsSync('uploads')) {
  fs.mkdirSync('uploads');
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'uploads/'),
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + '-' + file.originalname);
  }
});
const upload = multer({ storage });

// ==========================================
// 3. ХЕЛПЕР ДЛЯ ЗАВАНТАЖЕННЯ У ХМАРУ
// ==========================================
const uploadToCloudinary = async (filePath, folder, resourceType = 'raw') => {
  try {
    const result = await cloudinary.uploader.upload(filePath, {
      folder: `3dhub/${folder}`,
      resource_type: resourceType,
      use_filename: true,
      unique_filename: true
    });
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath); 
    return result.secure_url;
  } catch (error) {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath); 
    console.error(`Помилка Cloudinary у папці ${folder}:`, error);
    throw new Error('Не вдалося завантажити файл у хмарне сховище');
  }
};


mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('MongoDB Connected'))
  .catch(err => console.log(err));

const UserSchema = new mongoose.Schema({
  icon: {type: String},
  name: { type: String, required: true },
  email: { type: String, unique: true, required: true },
  password: { type: String, required: true },
  savedModels: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Model3D' }]
});
const User = mongoose.model('User', UserSchema);

const ModelSchema = new mongoose.Schema({
  title: String,
  description: String,
  fileUrl: String,
  userId: String 
});
const Model3D = mongoose.model('Model3D', ModelSchema);

const OrderSchema = new mongoose.Schema({
  title: { type: String, required: true },
  description: { type: String, required: true },
  customer: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }, 
  worker: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },   
  deadline: { type: Date, required: true }, 
  status: { 
    type: String, 
    enum: ['open', 'in-progress', 'completed'], 
    default: 'open' 
  },
  glbFileUrl: { type: String, default: null },
  fbxFileUrl: { type: String, default: null }
});
const Order = mongoose.model('Order', OrderSchema);


cron.schedule('*/5 * * * *', async () => {
  try {
    const now = new Date();
    const expiredOrders = await Order.find({
      status: 'in-progress',
      deadline: { $lt: now } 
    });

    if (expiredOrders.length > 0) {
      console.log(`Overdue orders found: ${expiredOrders.length}. Returning to the stock exchange...`);
      await Order.updateMany(
        { status: 'in-progress', deadline: { $lt: now } },
        { $set: { status: 'open', worker: null } }
      );
    }
  } catch (err) {
    console.error("Deadline check cron error:", err);
  }
});



app.post('/api/orders', async (req, res) => {
  try {
    const { title, description, customerId, daysToComplete } = req.body;
    const deadlineDate = new Date();
    deadlineDate.setDate(deadlineDate.getDate() + Number(daysToComplete));

    const newOrder = new Order({
      title, description, customer: customerId, deadline: deadlineDate
    });

    await newOrder.save();
    res.json(newOrder);
  } catch (err) {
    res.status(500).json({ error: 'Error creating order' });
  }
});

app.get('/api/orders', async (req, res) => {
  try {
    const orders = await Order.find({ status: 'open' }).populate('customer', 'name icon');
    res.json(orders);
  } catch (err) {
    res.status(500).json({ error: 'Error loading orders' });
  }
});

app.put('/api/orders/:id/take', async (req, res) => {
  try {
    const { workerId } = req.body;
    const order = await Order.findById(req.params.id);

    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.status !== 'open') return res.status(400).json({ error: 'Someone has already taken this order!' });

    order.worker = workerId;
    order.status = 'in-progress';
    await order.save();

    res.json({ message: 'You have successfully taken the order!', order });
  } catch (err) {
    res.status(500).json({ error: 'Error while taking order' });
  }
});

app.put('/api/orders/:id/complete', upload.fields([
  { name: 'glbOrderFile', maxCount: 1 },
  { name: 'fbxOrderFile', maxCount: 1 }
]), async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.status !== 'in-progress') return res.status(400).json({ error: 'This order is not in progress or the time has expired!' });

    if (req.files['glbOrderFile']) {
      order.glbFileUrl = await uploadToCloudinary(req.files['glbOrderFile'][0].path, 'orders', 'raw');
    }
    if (req.files['fbxOrderFile']) {
      order.fbxFileUrl = await uploadToCloudinary(req.files['fbxOrderFile'][0].path, 'orders', 'raw');
    }

    if (!order.glbFileUrl && !order.fbxFileUrl) {
      return res.status(400).json({ error: 'You must upload at least one file (.glb or .fbx)' });
    }

    order.status = 'completed';
    await order.save();
    res.json({ message: 'The work has been successfully submitted!', order });
  } catch (err) {
    console.error("Order submission error:", err);
    res.status(500).json({ error: 'Server error when submitting work' });
  }
});

app.get('/api/users/:id/my-orders', async (req, res) => {
  try {
    const userId = req.params.id;
    const orders = await Order.find({
      $or: [{ customer: userId }, { worker: userId }]
    }).populate('customer worker', 'name email icon');
    res.json(orders);
  } catch (err) {
    res.status(500).json({ error: 'Error loading user orders' });
  }
});

app.post('/api/register', upload.single('iconFile'), async (req, res) => {
  try {
    const { name, email, password } = req.body;
    
    const existingUser = await User.findOne({ email });
    if (existingUser) return res.status(400).json({ error: "A user with this email already exists!" });

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    let cloudIconUrl = null;
    if (req.file) {
      cloudIconUrl = await uploadToCloudinary(req.file.path, 'icons', 'image');
    }

    const newUser = new User({ 
      name, email, icon: cloudIconUrl, password: hashedPassword 
    });
    
    await newUser.save();
    res.json({ userId: newUser._id, name: newUser.name, email: newUser.email, icon: newUser.icon });
  } catch (err) {
    console.error("Registration error:", err);
    res.status(500).json({ error: "Server error during registration" });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email });
    if (!user) return res.status(404).json({ error: "User does not exist!" });

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(400).json({ error: "Incorrect password!" });

    res.json({ userId: user._id, name: user.name, email: user.email, icon: user.icon });
  } catch (err) {
    res.status(500).json({ error: "Server error while logging in" });
  }
});

app.get('/api/models', async (req, res) => {
  const { search, userId } = req.query;
  const query = {};
  if (search) query.title = { $regex: search, $options: 'i' };
  if (userId) query.userId = userId;
  const models = await Model3D.find(query);
  res.json(models);
});

app.get('/api/users', async (req, res) => {
  const { search, userId } = req.query;
  const query = {};
  if (search) query.name = { $regex: search, $options: 'i' };
  if (userId) query.userId = userId;
  const users = await User.find(query);
  res.json(users);
});

app.get('/api/users/:id', async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/user/:id', async (req, res) => {
  try {
    const user = await User.findById(req.params.id).select('-password'); 
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json(user);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/models/:id', async (req, res) => {
  try {
    const model = await Model3D.findById(req.params.id);
    if (!model) return res.status(404).json({ error: 'Model not found' });
    
    const user = await User.findById(model.userId);
    const modelWithAuthor = {
      ...model.toObject(), 
      authorName: user ? user.name : 'Anonymous user' 
    };
    res.json(modelWithAuthor);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/models', upload.single('modelFile'), async (req, res) => {
  try {
    let cloudUrl = null;
    if (req.file) {
      cloudUrl = await uploadToCloudinary(req.file.path, 'gallery', 'raw');
    }

    const newModel = new Model3D({
      title: req.body.title,
      description: req.body.description,
      fileUrl: cloudUrl,
      userId: req.body.userId 
    });
    
    await newModel.save();
    res.json(newModel);
  } catch (err) {
    res.status(500).json({ error: "Error saving model" });
  }
});

app.delete('/api/models/:id', async(req, res) => {
  try {
    const model = await Model3D.findByIdAndDelete(req.params.id);
    if (!model) return res.status(404).json({ error: 'This model does not exist' });
        
    res.json({ message: 'Model successfully deleted from database' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server problem' });
  }
});

app.put('/api/models/:id', upload.single('modelFile'), async (req, res) => {
  try {
    const model = await Model3D.findById(req.params.id);
    if (!model) return res.status(404).json({ error: 'Model not found' });

    model.title = req.body.title || model.title;
    model.description = req.body.description || model.description;

    if (req.file) {
      model.fileUrl = await uploadToCloudinary(req.file.path, 'gallery', 'raw');
    }

    await model.save();
    res.json({ message: 'The model has been successfully updated!', model });
  } catch (err) {
    console.error("Server error during update:", err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.put('/api/users/:id', upload.single('iconFile'), async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    user.name = req.body.name || user.name;

    if (req.body.password) {
      const salt = await bcrypt.genSalt(10);
      user.password = await bcrypt.hash(req.body.password, salt);
    }

    if (req.file) {
      user.icon = await uploadToCloudinary(req.file.path, 'icons', 'image');
    }

    await user.save();

    const updatedUser = {
      userId: user._id,
      name: user.name,
      email: user.email,
      icon: user.icon
    };

    res.json({ message: 'User successfully updated!', user: updatedUser });

  } catch (err) {
    console.error("Update user error:", err);
    res.status(500).json({ error: 'Update error! See console F12.' });
  }
});

app.post('/api/users/:id/save-model', async (req, res) => {
  try {
    const { modelId } = req.body;
    const user = await User.findById(req.params.id);

    if (!user) return res.status(404).json({ error: 'User not found' });

    const isSaved = user.savedModels.includes(modelId);

    if (isSaved) {
      user.savedModels = user.savedModels.filter(id => id.toString() !== modelId);
    } else {
      user.savedModels.push(modelId);
    }

    await user.save();
    res.json({ savedModels: user.savedModels });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/users/:id/saved-models', async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    if (!user.savedModels || user.savedModels.length === 0) {
      return res.json([]);
    }

    const savedModels = await Model3D.find({ _id: { $in: user.savedModels } });
    res.json(savedModels);
  } catch (err) {
    console.error("Error loading saved models:", err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.listen(process.env.PORT || 5000, () => {
  console.log(`Server running on port ${process.env.PORT || 5000}`);
});