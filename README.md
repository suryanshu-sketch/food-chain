# Agri-Supply Chain Backend

India's most accessible agri-supply chain platform with zero digital literacy barriers for farmers.

## 🌾 Core Mission

Build India's most accessible agri-supply chain with:
- ✅ Zero digital literacy barriers for farmers
- ✅ Hyper-local trust networks via community ratings  
- ✅ Profitable shared logistics eliminating warehouses

## 🏗️ Architecture Overview

### User Roles & Tech Stack

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
5. **Agent scans** via Agent App → Auto-alert: "10kg picked ✓" (SMS/WhatsApp)
6. **Delivery**: Vendor receives batch + auto-generated rating link (in-app)
7. **Payment**: Farmer paid via UPI auto-notification
8. **Feedback**: Vendor rates hygiene/quality → Badges updated in real-time

## 🛡️ Trust & Hygiene Engine

| Mechanism | Implementation | Impact |
|-----------|---------------|---------|
| **Community Ratings** | 1–5 stars per delivery (mandatory in-app) | Triggers automatic hygiene badges/suspensions |
| **Hygiene Badge** | Green (5★ avg), Yellow (3★), Red (2+ complaints) | Displayed prominently in vendor/farmer profiles |
| **Batch Photos** | Agent app uploads timestamped sack/quality pics | Visual proof for disputes |
| **AI Dispute Assist** | Image analysis for mold/damage detection | Reduces admin workload by 40% (Phase 3) |

## 📱 Hybrid Communication System

### Farmers
- **Alerts**: WhatsApp/SMS for pickups, payments, ratings
- **Support**: IVR menu (Press 1 for payment issues)
- **Future**: Voice-controlled "Farmer Lite" app (offline-enabled)

### Vendors
- **All transactions** via mobile app
- **WhatsApp ONLY** for: Order shipped/delivered alerts

### Agents
- **Primary**: Agent App for routes/scans/earnings
- **WhatsApp ONLY** for: Urgent route changes, weather alerts

## 💰 Revenue Model

| Stream | Mechanics | Projected Margin |
|--------|-----------|------------------|
| **Vendor Fee** | ₹8 per successful delivery | 65% revenue |
| **Pickup Margin** | ₹3/kg for premium routes | 20% revenue |
| **Ads** | Fertilizer shops on farmer alerts | 10% revenue |
| **Premium Subscriptions** | Early delivery slots, bulk pricing | 5% revenue |

## 🛠️ Technology Stack

| Component | Technology | Purpose |
|-----------|------------|---------|
| **Backend** | Node.js + Express | Real-time order routing |
| **Database** | PostgreSQL + PostGIS | Geo-tagged data storage |
| **Authentication** | JWT + OTP | Secure API access |
| **Communications** | Twilio (SMS) + Gupshup (WhatsApp) + Exotel (IVR) | Multi-channel notifications |
| **File Storage** | AWS S3 | Image uploads (products, proofs, ratings) |
| **Real-time** | Socket.IO | Live updates |
| **Logging** | Winston | Structured logging |

## 🚀 Quick Start

### Prerequisites
- Node.js >= 16.0.0
- PostgreSQL with PostGIS extension
- AWS S3 bucket
- Twilio account (SMS)
- Gupshup account (WhatsApp)
- Exotel account (IVR)

### Installation

1. **Clone and install dependencies**
```bash
git clone <repository-url>
cd agri-supply-chain-backend
npm install
```

2. **Environment Setup**
```bash
cp .env.example .env
# Edit .env with your configuration
```

3. **Database Setup**
```bash
# Create PostgreSQL database
createdb agri_supply_chain

# Run migrations
npm run migrate

# Seed initial data (optional)
npm run seed
```

4. **Start the server**
```bash
# Development
npm run dev

# Production
npm start
```

## 📊 API Endpoints

### Authentication
- `POST /api/auth/send-otp` - Send OTP for phone verification
- `POST /api/auth/verify-otp` - Verify OTP and login/register
- `GET /api/auth/profile` - Get user profile
- `PUT /api/auth/profile` - Update user profile

### Farmers
- `GET /api/farmers/dashboard` - Farmer dashboard stats
- `POST /api/farmers/listings` - Create product listing
- `GET /api/farmers/listings` - Get farmer's listings
- `GET /api/farmers/orders` - Get farmer's orders
- `GET /api/farmers/earnings` - Get earnings summary

### Vendors
- `GET /api/vendors/dashboard` - Vendor dashboard stats
- `GET /api/vendors/products` - Browse available products
- `POST /api/vendors/orders` - Place new order
- `GET /api/vendors/orders` - Get vendor's orders
- `GET /api/vendors/nearby-farmers` - Find nearby farmers

### Agents
- `GET /api/agents/dashboard` - Agent dashboard stats
- `GET /api/agents/routes` - Get assigned routes
- `POST /api/agents/scan-qr` - Scan QR code for pickup/delivery
- `POST /api/agents/location` - Update real-time location
- `GET /api/agents/earnings` - Get earnings summary

### Orders
- `GET /api/orders/:orderId` - Get order details
- `PUT /api/orders/:orderId/status` - Update order status
- `POST /api/orders/:orderId/dispute` - Raise dispute
- `GET /api/orders/analytics/summary` - Order analytics (admin)

### Routes
- `POST /api/routes/optimize` - Create optimized routes
- `GET /api/routes/:routeId` - Get route details
- `PUT /api/routes/:routeId/status` - Update route status
- `GET /api/routes/analytics/summary` - Route analytics

### Ratings
- `POST /api/ratings/orders/:orderId` - Submit rating
- `GET /api/ratings/user/:userId` - Get user ratings
- `GET /api/ratings/leaderboard/hygiene` - Hygiene leaderboard

### Communications
- `POST /api/communications/whatsapp/webhook` - WhatsApp webhook
- `POST /api/communications/ivr/webhook` - IVR webhook
- `POST /api/communications/send` - Send notification (admin)
- `GET /api/communications/history/:userId` - Communication history

### Admin
- `GET /api/admin/dashboard` - System overview
- `GET /api/admin/users` - Manage users
- `GET /api/admin/analytics` - System analytics
- `GET /api/admin/disputes` - Manage disputes
- `POST /api/admin/bulk-operations` - Bulk user operations

### Dashboard
- `GET /api/dashboard` - Unified dashboard (role-based)
- `GET /api/dashboard/notifications` - Get notifications
- `PUT /api/dashboard/notifications/:id/read` - Mark notification as read

## 🔐 Security Features

- **JWT Authentication** with role-based access control
- **Rate limiting** to prevent API abuse
- **Input validation** using Joi schemas
- **SQL injection protection** via parameterized queries
- **CORS configuration** for cross-origin requests
- **Helmet.js** for security headers
- **Environment variable protection** for sensitive data

## 📈 Key Performance Indicators

- **Farmer Inclusion**: <10 sec task completion (via voice/IVR)
- **Trust Factor**: >4.2 avg hygiene rating
- **Cost Efficiency**: ₹0.80/km logistics cost (shared routes)
- **Growth**: 30% monthly vendor acquisition

## 🌍 Phase-Based Rollout Plan

### Pilot (Month 1–3)
- **Districts**: Varanasi + Prayagraj
- **Farmers**: 200 (WhatsApp/SMS only)
- **Vendors**: 50 (mandatory app use)
- **Key Metric**: >90% on-time deliveries

### Scale (Month 4–6)
- Launch "Farmer Lite" app (voice-enabled)
- Partner with 1 EV logistics startup
- **Target**: 1,000 farmers | 200 vendors

### Nationwide (Year 1+)
- Full SMS/IVR fallback coverage
- Integrate government subsidy APIs
- AI dispute system automation

## 🏃‍♂️ Development Commands

```bash
npm start          # Start production server
npm run dev        # Start development server with nodemon
npm test           # Run test suite
npm run migrate    # Run database migrations
npm run seed       # Seed database with sample data
```

## 📝 Environment Variables

See `.env` file for complete configuration. Key variables:

- `DB_*` - PostgreSQL database configuration
- `JWT_SECRET` - JWT signing secret
- `AWS_*` - AWS S3 configuration
- `TWILIO_*` - SMS service configuration
- `GUPSHUP_*` - WhatsApp API configuration
- `EXOTEL_*` - IVR service configuration

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests for new functionality
5. Submit a pull request

## 📄 License

This project is licensed under the MIT License.

## 🎯 Final Vision

A self-sustaining ecosystem where technology adapts to people – not vice versa.

- **Farmers**: Never need smartphones → WhatsApp/SMS protects inclusivity
- **Vendors**: App-first design enables complex features (dynamic pricing, analytics)  
- **Planet**: Shared EV routes cut emissions by 60% vs traditional models
- **Business**: Revenue diversified across 4 streams; reduces Meta dependency