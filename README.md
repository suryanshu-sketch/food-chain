# Agri-Supply Chain Backend

India's most accessible agri-supply chain platform with zero digital literacy barriers, hyper-local trust networks, and profitable shared logistics.

## 🌾 Core Mission

Build India's most accessible agri-supply chain:
- ✅ **Zero digital literacy barriers** for farmers (WhatsApp + IVR/SMS)
- ✅ **Hyper-local trust networks** via community ratings & hygiene badges
- ✅ **Profitable shared logistics** eliminating warehouses through EV routes

## 🚀 Quick Start

### Prerequisites

- Node.js (>=16.0.0)
- PostgreSQL (>=12) with PostGIS extension
- Redis (for caching)
- AWS S3 bucket (for image storage)

### Installation

1. **Clone and install dependencies:**
```bash
git clone <repository-url>
cd agri-supply-chain-backend
npm install
```

2. **Setup environment variables:**
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

# Seed with sample data
npm run seed
```

4. **Start the server:**
```bash
# Development
npm run dev

# Production
npm start
```

The server will start on `http://localhost:3000`

## 📱 User Roles & Tech Stack

| User | Primary Interface | Key Actions | Critical Tech Shift |
|------|------------------|-------------|-------------------|
| **Farmer** | WhatsApp + IVR/SMS → (Phase 2: Farmer Lite App) | Register, list produce, receive alerts/payments | WhatsApp retained ONLY for alerts; SMS fallback added |
| **Vendor** | Mobile App (Android/iOS) | Browse farmers, place orders, track deliveries, rate quality | Full migration from WhatsApp ordering |
| **Pickup Agent** | Dedicated Agent App | Scan QR codes, optimize routes, submit photo proofs | WhatsApp only for emergency alerts |
| **Admin** | Web Dashboard | Dispute resolution, route planning, hygiene monitoring | Unchanged |

## 🔄 Revolutionized Order Lifecycle

1. **Listing**: Farmer → WhatsApp/IVR → "20kg tomatoes available tomorrow"
2. **Ordering**: Vendor → Mobile App → Orders "10kg to Sharma Chaat Center"
3. **Routing**: System auto-groups orders → Shared EV route planned
4. **Pickup**: Farmer drops sack at village pickup point (QR pre-tagged)
   - Agent scans via Agent App → Auto-alert: "10kg picked ✓" (SMS/WhatsApp)
5. **Delivery**: Vendor receives batch + auto-generated rating link (in-app)
   - Farmer paid via UPI auto-notification
6. **Feedback**: Vendor rates hygiene/quality → Badges updated in real-time

## 🏗️ Architecture

### Backend Stack
- **Framework**: Node.js + Express.js
- **Database**: PostgreSQL + PostGIS (geospatial data)
- **Authentication**: JWT tokens + OTP verification
- **File Storage**: AWS S3
- **Real-time**: Socket.IO
- **Logging**: Winston
- **Validation**: Joi

### Communication Stack
- **SMS**: Twilio
- **WhatsApp**: Gupshup API
- **IVR**: Exotel
- **Smart Routing**: Automatic fallback (WhatsApp → SMS → IVR)

### Key Features
- **Hybrid Communication**: Adapts to user's digital literacy
- **Trust & Hygiene Engine**: Community ratings with automated badges
- **Route Optimization**: Shared EV logistics with dynamic planning
- **QR Ecosystem**: Farmer ID + Order tracking
- **Dispute Resolution**: AI-assisted with admin oversight

## 📊 Database Schema

### Core Tables
- `users` - Base user authentication
- `farmers` - Farmer profiles with geolocation
- `vendors` - Vendor business profiles
- `pickup_agents` - Agent details with vehicle info
- `products` - Crop/produce catalog
- `listings` - Farmer product availability
- `orders` - Order management
- `routes` - Logistics route planning
- `ratings` - Trust & hygiene ratings
- `communications` - Message history
- `disputes` - Conflict resolution

### Geospatial Features
- PostGIS for location-based matching
- Optimized route planning algorithms
- Distance-based vendor discovery

## 🛡️ Security & Authentication

### Authentication Flow
1. **Phone Verification**: OTP via SMS/WhatsApp
2. **JWT Tokens**: Secure API access
3. **Role-based Access**: Farmer/Vendor/Agent/Admin permissions
4. **Rate Limiting**: API abuse prevention

### Security Measures
- Helmet.js for HTTP headers
- Input validation with Joi
- SQL injection prevention
- File upload restrictions
- Error handling without data leakage

## 📡 API Documentation

### Authentication Endpoints
```
POST /api/auth/send-otp          # Send OTP for verification
POST /api/auth/verify-otp        # Verify OTP and login/register
GET  /api/auth/profile           # Get user profile
PUT  /api/auth/profile           # Update user profile
POST /api/auth/logout            # Logout user
```

### Farmer Endpoints
```
GET  /api/farmers/dashboard      # Farmer dashboard stats
GET  /api/farmers/products       # Available products catalog
POST /api/farmers/listings       # Create new listing
GET  /api/farmers/listings       # Get farmer's listings
PUT  /api/farmers/listings/:id   # Update listing
GET  /api/farmers/orders         # View orders
POST /api/farmers/orders/:id/confirm # Confirm order
GET  /api/farmers/earnings       # Earnings summary
GET  /api/farmers/qr-code        # Get QR code
```

### Vendor Endpoints
```
GET  /api/vendors/dashboard      # Vendor dashboard
GET  /api/vendors/products       # Browse available products
GET  /api/vendors/products/:id   # Get product details
POST /api/vendors/orders         # Place new order
GET  /api/vendors/orders         # View orders
GET  /api/vendors/orders/:id     # Order details
POST /api/vendors/orders/:id/cancel # Cancel order
GET  /api/vendors/nearby-farmers # Find nearby farmers
GET  /api/vendors/analytics      # Spending analytics
```

### Agent Endpoints
```
GET  /api/agents/dashboard       # Agent dashboard
GET  /api/agents/routes          # Assigned routes
GET  /api/agents/routes/:id      # Route details
POST /api/agents/routes/:id/start # Start route
POST /api/agents/scan-qr         # Scan QR for pickup/delivery
POST /api/agents/location        # Update location
POST /api/agents/routes/:id/complete # Complete route
GET  /api/agents/earnings        # Earnings summary
GET  /api/agents/performance     # Performance metrics
```

### Order Management
```
GET  /api/orders/:id             # Order details
PUT  /api/orders/:id/status      # Update order status (admin/agent)
GET  /api/orders/:id/tracking    # Real-time tracking
POST /api/orders/:id/dispute     # Raise dispute
GET  /api/orders/:id/disputes    # View disputes (admin)
PUT  /api/orders/disputes/:id/resolve # Resolve dispute (admin)
```

### Ratings & Trust
```
POST /api/ratings/orders/:id     # Submit rating for order
GET  /api/ratings/user/:id       # Get user ratings
GET  /api/ratings/leaderboard/hygiene # Hygiene leaderboard
POST /api/ratings/:id/report     # Report inappropriate rating
GET  /api/ratings/analytics/summary # Rating analytics (admin)
```

### Communications
```
POST /api/communications/whatsapp/webhook # WhatsApp webhook
POST /api/communications/ivr/webhook # IVR webhook
POST /api/communications/send    # Send notification (admin)
GET  /api/communications/history/:id # Communication history
GET  /api/communications/analytics # Communication analytics
PUT  /api/communications/preferences # Update preferences
```

### Admin Dashboard
```
GET  /api/admin/dashboard        # System overview
GET  /api/admin/users            # User management
PUT  /api/admin/users/:id/status # Activate/deactivate user
GET  /api/admin/analytics        # System analytics
GET  /api/admin/disputes         # All disputes
PUT  /api/admin/verify/:type/:id # Verify user
POST /api/admin/bulk-operations  # Bulk operations
GET  /api/admin/config           # System configuration
PUT  /api/admin/config           # Update configuration
GET  /api/admin/export/:type     # Export data
```

### Route Optimization
```
POST /api/routes/optimize        # Create optimized routes (admin)
GET  /api/routes/:id             # Route details
GET  /api/routes/                # All routes (admin)
PUT  /api/routes/:id/status      # Update route status
PUT  /api/routes/:id/reassign    # Reassign route to agent
GET  /api/routes/analytics/summary # Route analytics
POST /api/routes/suggestions     # Route optimization suggestions
```

## 🔧 Configuration

### Environment Variables

```bash
# Database
DB_HOST=localhost
DB_PORT=5432
DB_NAME=agri_supply_chain
DB_USER=postgres
DB_PASSWORD=your_password

# Server
PORT=3000
NODE_ENV=development
JWT_SECRET=your_super_secret_jwt_key

# AWS S3
AWS_ACCESS_KEY_ID=your_aws_access_key
AWS_SECRET_ACCESS_KEY=your_aws_secret_key
AWS_REGION=ap-south-1
AWS_S3_BUCKET=agri-supply-chain-images

# Communications
TWILIO_ACCOUNT_SID=your_twilio_sid
TWILIO_AUTH_TOKEN=your_twilio_token
TWILIO_PHONE_NUMBER=+1234567890

GUPSHUP_API_KEY=your_gupshup_key
GUPSHUP_APP_NAME=your_app_name

EXOTEL_API_KEY=your_exotel_key
EXOTEL_API_TOKEN=your_exotel_token
EXOTEL_SID=your_exotel_sid

# Payment
UPI_MERCHANT_ID=your_upi_merchant_id
UPI_MERCHANT_KEY=your_upi_merchant_key

# Redis
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=
```

## 🎯 Trust & Hygiene Engine

### Rating System
- **5-Star Scale**: Mandatory vendor ratings per delivery
- **Multi-dimensional**: Overall, Hygiene, Quality, Delivery ratings
- **Visual Proof**: Photo uploads for quality verification
- **Community Driven**: Peer verification system

### Hygiene Badges
- 🟢 **Green Badge**: 4.0+ average rating (trusted farmer)
- 🟡 **Yellow Badge**: 3.0-3.9 average (needs improvement)
- 🔴 **Red Badge**: <3.0 average (temporary suspension)

### Automated Actions
- Badge updates in real-time
- Temporary suspension for red badge farmers
- Dispute escalation for quality issues
- Performance alerts for agents

## 🚛 Logistics & Sustainability

### Shared EV Routes
- **Efficiency**: 1 van serves 8-12 farmers/vendors per trip
- **Optimization**: Dynamic route planning based on orders
- **Cost Reduction**: 60% emission reduction vs traditional models
- **Real-time Tracking**: GPS-based location updates

### QR Ecosystem
- **Farmer QR**: Static QR for farmer identification
- **Order QR**: Dynamic QR for each order tracking
- **Pickup Verification**: Agent scans for proof of pickup
- **Delivery Confirmation**: Final scan at vendor location

## 💰 Revenue Model

| Stream | Mechanics | Projected Margin |
|--------|-----------|------------------|
| **Vendor Fee** | ₹8 per successful delivery | 65% revenue |
| **Pickup Margin** | ₹3/kg for premium routes | 20% revenue |
| **Ads** | Fertilizer shops on farmer alerts | 10% revenue |
| **Premium Subscriptions** | Early delivery slots, bulk pricing | 5% revenue |

## 📈 Phase-Based Rollout Plan

### Phase 1: Pilot (Month 1-3)
- **Districts**: Varanasi + Prayagraj
- **Farmers**: 200 (WhatsApp/SMS only)
- **Vendors**: 50 (mandatory app use)
- **Key Metric**: >90% on-time deliveries

### Phase 2: Scale (Month 4-6)
- Launch "Farmer Lite" app (voice-enabled)
- Partner with 1 EV logistics startup
- **Target**: 1,000 farmers | 200 vendors

### Phase 3: Nationwide (Year 1+)
- Full SMS/IVR fallback coverage
- Integrate government subsidy APIs
- AI dispute system automation

## 🔍 Monitoring & Analytics

### Key Performance Indicators
- **Farmer Inclusion**: <10 sec task completion (via voice/IVR)
- **Trust Factor**: >4.2 avg hygiene rating
- **Cost Efficiency**: ₹0.80/km logistics cost (shared routes)
- **Growth**: 30% monthly vendor acquisition

### Real-time Dashboards
- Order fulfillment rates
- Route optimization metrics
- User engagement analytics
- Revenue tracking
- Dispute resolution times

## 🧪 Testing

```bash
# Run tests
npm test

# Test specific module
npm test -- --grep "auth"

# Integration tests
npm run test:integration
```

## 📚 Development Scripts

```bash
npm run dev          # Start development server with nodemon
npm run start        # Start production server
npm run migrate      # Run database migrations
npm run seed         # Seed database with sample data
npm run seed -- --clear  # Clear and reseed database
npm test             # Run test suite
```

## 🤝 Contributing

1. Fork the repository
2. Create feature branch (`git checkout -b feature/amazing-feature`)
3. Commit changes (`git commit -m 'Add amazing feature'`)
4. Push to branch (`git push origin feature/amazing-feature`)
5. Open Pull Request

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🆘 Support

For support, email support@agrisupplychain.com or join our Slack channel.

## 🔮 Future Enhancements

- **AI Quality Detection**: Computer vision for automatic quality grading
- **Blockchain Integration**: Transparent supply chain tracking
- **IoT Sensors**: Real-time crop monitoring
- **ML Route Optimization**: Advanced algorithms for logistics
- **Multi-language Support**: Regional language interfaces
- **Weather Integration**: Climate-based recommendations

---

**Vision**: A self-sustaining ecosystem where technology adapts to people – not vice versa. 🌾✨