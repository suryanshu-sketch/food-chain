# Agri-Supply Chain Backend

India's most accessible agri-supply chain platform with zero digital literacy barriers for farmers.

## 🌾 Vision

Build a self-sustaining ecosystem where technology adapts to people – not vice versa. Our platform revolutionizes agricultural supply chains by:

- ✅ **Zero digital literacy barriers** for farmers (WhatsApp + IVR/SMS)
- ✅ **Hyper-local trust networks** via community ratings and hygiene badges
- ✅ **Profitable shared logistics** eliminating warehouses through EV route optimization
- ✅ **Hybrid communication system** supporting multiple channels with intelligent fallbacks

## 🚀 Quick Start

### Prerequisites

- Node.js (v16+)
- PostgreSQL (v12+) with PostGIS extension
- Redis (optional, for caching)
- AWS S3 bucket for image storage
- API keys for communication services (Twilio, Gupshup, Exotel)

### Installation

1. **Clone and install dependencies:**
```bash
git clone <repository-url>
cd agri-supply-chain-backend
npm install
```

2. **Configure environment variables:**
```bash
cp .env.example .env
# Edit .env with your configuration
```

3. **Setup database:**
```bash
# Create PostgreSQL database
createdb agri_supply_chain

# Run migrations
npm run migrate

# Seed sample data
npm run seed
```

4. **Start the server:**
```bash
# Development
npm run dev

# Production
npm start
```

## 🏗 System Architecture

### User Roles & Tech Stack

| User Type | Primary Interface | Key Actions | Communication |
|-----------|------------------|-------------|---------------|
| **Farmer** | WhatsApp + IVR/SMS | Register, list produce, receive payments | WhatsApp alerts, SMS fallback |
| **Vendor** | Mobile App | Browse, order, track, rate quality | In-app notifications |
| **Agent** | Agent App | Scan QR, optimize routes, upload proofs | App-based with WhatsApp alerts |
| **Admin** | Web Dashboard | Monitor, resolve disputes, analytics | Web interface |

### Order Lifecycle

1. **Listing**: Farmer → WhatsApp/IVR → "20kg tomatoes available tomorrow"
2. **Ordering**: Vendor → Mobile App → Orders "10kg to Sharma Chaat Center"
3. **Routing**: System auto-groups orders → Shared EV route planned
4. **Pickup**: Agent scans QR at village pickup point → Auto-alert sent
5. **Delivery**: Vendor receives batch → Rating link generated
6. **Payment**: Farmer paid via UPI → Auto-notification sent
7. **Feedback**: Vendor rates hygiene/quality → Badges updated real-time

## 📱 API Documentation

### Authentication

All authenticated endpoints require JWT token in Authorization header:
```
Authorization: Bearer <jwt_token>
```

### Core Endpoints

#### Authentication
- `POST /api/auth/send-otp` - Send OTP for phone verification
- `POST /api/auth/verify-otp` - Verify OTP and login/register
- `GET /api/auth/profile` - Get user profile
- `PUT /api/auth/profile` - Update user profile

#### Farmers
- `GET /api/farmers/dashboard` - Farmer dashboard stats
- `POST /api/farmers/listings` - Create product listing (with image upload)
- `GET /api/farmers/listings` - Get farmer's listings
- `GET /api/farmers/orders` - Get farmer's orders
- `POST /api/farmers/orders/:id/confirm` - Confirm order
- `GET /api/farmers/earnings` - View earnings

#### Vendors
- `GET /api/vendors/dashboard` - Vendor dashboard stats
- `GET /api/vendors/products` - Browse available products
- `POST /api/vendors/orders` - Place new order
- `GET /api/vendors/orders` - View vendor's orders
- `GET /api/vendors/nearby-farmers` - Find nearby farmers

#### Agents
- `GET /api/agents/dashboard` - Agent dashboard stats
- `GET /api/agents/routes` - Get assigned routes
- `POST /api/agents/scan-qr` - Scan QR for pickup/delivery
- `POST /api/agents/location` - Update real-time location
- `GET /api/agents/earnings` - View earnings

#### Orders & Routes
- `GET /api/orders/:id` - Get order details
- `POST /api/routes/optimize` - Create optimized routes (admin)
- `GET /api/routes/:id` - Get route details

#### Ratings & Trust
- `POST /api/ratings/orders/:id` - Submit rating for delivered order
- `GET /api/ratings/leaderboard/hygiene` - Hygiene leaderboard

#### Communications
- `POST /api/communications/whatsapp/webhook` - WhatsApp webhook
- `POST /api/communications/ivr/webhook` - IVR webhook
- `POST /api/communications/send` - Send notification (admin)

#### Admin
- `GET /api/admin/dashboard` - System overview
- `GET /api/admin/users` - Manage users
- `GET /api/admin/analytics` - System analytics
- `GET /api/admin/disputes` - View/resolve disputes

### Response Format

All API responses follow this format:
```json
{
  "success": true,
  "message": "Operation successful",
  "data": { ... },
  "pagination": { ... } // For paginated responses
}
```

Error responses:
```json
{
  "success": false,
  "message": "Error description",
  "error": "VALIDATION_ERROR" // Error code
}
```

## 🛠 Technology Stack

### Backend
- **Framework**: Node.js with Express.js
- **Database**: PostgreSQL with PostGIS (geospatial support)
- **Authentication**: JWT with OTP verification
- **File Storage**: AWS S3
- **Real-time**: Socket.IO
- **Validation**: Joi
- **Logging**: Winston

### Communication Services
- **SMS**: Twilio
- **WhatsApp**: Gupshup API
- **IVR**: Exotel
- **Smart Routing**: Multi-channel with fallbacks

### Key Features
- **QR Code System**: Farmer ID + Order tracking
- **Route Optimization**: Nearest-neighbor algorithm
- **Trust Engine**: Community ratings with hygiene badges
- **Hybrid Communication**: WhatsApp/SMS/IVR based on user type
- **Real-time Tracking**: Socket.IO for live updates

## 🌐 Database Schema

### Core Tables
- `users` - Base user table (farmers, vendors, agents, admin)
- `farmers` - Farmer profiles with location and hygiene ratings
- `vendors` - Vendor business details
- `agents` - Pickup agent information
- `products` - Product catalog
- `listings` - Farmer product listings
- `orders` - Order management
- `routes` - Logistics routes
- `ratings` - Trust and hygiene system
- `communications` - Message history
- `disputes` - Dispute resolution

### Geospatial Features
- PostGIS for location-based queries
- Distance calculations for route optimization
- Nearby farmer/vendor discovery

## 🔐 Security Features

- **Rate Limiting**: Express rate limiter
- **Input Validation**: Joi schema validation
- **SQL Injection Protection**: Parameterized queries
- **JWT Security**: Secure token generation and validation
- **File Upload Security**: Multer with file type validation
- **HTTP Security**: Helmet middleware

## 📊 Revenue Model

| Stream | Mechanism | Projected Margin |
|--------|-----------|------------------|
| **Vendor Fee** | ₹8 per successful delivery | 65% revenue |
| **Pickup Margin** | ₹3/kg for premium routes | 20% revenue |
| **Ads** | Fertilizer shops on farmer alerts | 10% revenue |
| **Premium** | Early delivery slots, bulk pricing | 5% revenue |

## 🚀 Deployment

### Environment Variables

Key environment variables to configure:

```env
# Database
DB_HOST=localhost
DB_NAME=agri_supply_chain
DB_USER=postgres
DB_PASSWORD=your_password

# JWT
JWT_SECRET=your_super_secret_jwt_key

# AWS S3
AWS_ACCESS_KEY_ID=your_aws_key
AWS_SECRET_ACCESS_KEY=your_aws_secret
AWS_S3_BUCKET=your_bucket_name

# Communication APIs
TWILIO_ACCOUNT_SID=your_twilio_sid
GUPSHUP_API_KEY=your_gupshup_key
EXOTEL_API_KEY=your_exotel_key

# Payment
UPI_MERCHANT_ID=your_upi_merchant_id
```

### Production Deployment

1. **Server Setup:**
```bash
# Install PM2 for process management
npm install -g pm2

# Start application
pm2 start src/server.js --name agri-backend

# Setup nginx reverse proxy
# Configure SSL certificates
```

2. **Database Optimization:**
```sql
-- Create indexes for performance
CREATE INDEX CONCURRENTLY idx_farmers_location ON farmers USING GIST(location);
CREATE INDEX CONCURRENTLY idx_orders_status ON orders(status);
CREATE INDEX CONCURRENTLY idx_listings_active ON listings(status) WHERE status = 'active';
```

## 📈 Monitoring & Analytics

### Key Performance Indicators

- **Farmer Inclusion**: <10 sec task completion (via voice/IVR)
- **Trust Factor**: >4.2 avg hygiene rating
- **Cost Efficiency**: ₹0.80/km logistics cost (shared routes)
- **Growth**: 30% monthly vendor acquisition

### Logging

Application uses structured logging with Winston:
- `logs/combined.log` - All application logs
- `logs/error.log` - Error logs only
- Console output in development mode

## 🧪 Testing

```bash
# Run tests
npm test

# Test specific endpoints
npm run test:auth
npm run test:orders
```

## 🤝 Contributing

1. Fork the repository
2. Create feature branch (`git checkout -b feature/amazing-feature`)
3. Commit changes (`git commit -m 'Add amazing feature'`)
4. Push to branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## 📞 Support

For technical support or questions:
- Email: tech@agrisupply.com
- Phone: +91-XXXX-XXXX-XX
- Documentation: [API Docs](https://docs.agrisupply.com)

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

---

**Built with ❤️ for India's farmers** 🇮🇳