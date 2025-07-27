-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "postgis";

-- Users table (base table for all user types)
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    phone_number VARCHAR(15) UNIQUE NOT NULL,
    user_type VARCHAR(20) NOT NULL CHECK (user_type IN ('farmer', 'vendor', 'agent', 'admin')),
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Farmers table
CREATE TABLE farmers (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL,
    village VARCHAR(100) NOT NULL,
    district VARCHAR(100) NOT NULL,
    state VARCHAR(100) NOT NULL,
    pincode VARCHAR(10) NOT NULL,
    location GEOGRAPHY(POINT, 4326),
    qr_code VARCHAR(255) UNIQUE,
    preferred_language VARCHAR(10) DEFAULT 'hi',
    hygiene_rating DECIMAL(2,1) DEFAULT 5.0,
    hygiene_badge VARCHAR(20) DEFAULT 'green' CHECK (hygiene_badge IN ('green', 'yellow', 'red')),
    total_deliveries INTEGER DEFAULT 0,
    bank_account_number VARCHAR(20),
    ifsc_code VARCHAR(11),
    upi_id VARCHAR(100),
    is_verified BOOLEAN DEFAULT false,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Vendors table
CREATE TABLE vendors (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    business_name VARCHAR(200) NOT NULL,
    owner_name VARCHAR(100) NOT NULL,
    business_type VARCHAR(50) NOT NULL,
    address TEXT NOT NULL,
    city VARCHAR(100) NOT NULL,
    state VARCHAR(100) NOT NULL,
    pincode VARCHAR(10) NOT NULL,
    location GEOGRAPHY(POINT, 4326),
    gst_number VARCHAR(15),
    license_number VARCHAR(50),
    is_verified BOOLEAN DEFAULT false,
    subscription_type VARCHAR(20) DEFAULT 'basic' CHECK (subscription_type IN ('basic', 'premium')),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Pickup Agents table
CREATE TABLE agents (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL,
    license_number VARCHAR(50) NOT NULL,
    vehicle_type VARCHAR(50) NOT NULL,
    vehicle_number VARCHAR(20) NOT NULL,
    current_location GEOGRAPHY(POINT, 4326),
    is_available BOOLEAN DEFAULT true,
    rating DECIMAL(2,1) DEFAULT 5.0,
    total_pickups INTEGER DEFAULT 0,
    earnings_today DECIMAL(10,2) DEFAULT 0,
    earnings_total DECIMAL(10,2) DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Products table
CREATE TABLE products (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(100) NOT NULL,
    category VARCHAR(50) NOT NULL,
    unit VARCHAR(20) NOT NULL DEFAULT 'kg',
    seasonal BOOLEAN DEFAULT false,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Farmer Products (what each farmer grows)
CREATE TABLE farmer_products (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    farmer_id UUID REFERENCES farmers(id) ON DELETE CASCADE,
    product_id UUID REFERENCES products(id) ON DELETE CASCADE,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(farmer_id, product_id)
);

-- Product Listings (farmer's available produce)
CREATE TABLE product_listings (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    farmer_id UUID REFERENCES farmers(id) ON DELETE CASCADE,
    product_id UUID REFERENCES products(id) ON DELETE CASCADE,
    quantity DECIMAL(10,2) NOT NULL,
    price_per_unit DECIMAL(10,2) NOT NULL,
    harvest_date DATE NOT NULL,
    expiry_date DATE,
    quality_grade VARCHAR(10) DEFAULT 'A' CHECK (quality_grade IN ('A', 'B', 'C')),
    description TEXT,
    images JSON,
    status VARCHAR(20) DEFAULT 'available' CHECK (status IN ('available', 'reserved', 'sold', 'expired')),
    qr_code VARCHAR(255) UNIQUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Orders table
CREATE TABLE orders (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    order_number VARCHAR(20) UNIQUE NOT NULL,
    vendor_id UUID REFERENCES vendors(id) ON DELETE CASCADE,
    farmer_id UUID REFERENCES farmers(id) ON DELETE CASCADE,
    product_listing_id UUID REFERENCES product_listings(id) ON DELETE CASCADE,
    quantity DECIMAL(10,2) NOT NULL,
    unit_price DECIMAL(10,2) NOT NULL,
    total_amount DECIMAL(10,2) NOT NULL,
    delivery_fee DECIMAL(10,2) DEFAULT 8.00,
    pickup_margin DECIMAL(10,2) DEFAULT 3.00,
    status VARCHAR(20) DEFAULT 'placed' CHECK (status IN ('placed', 'confirmed', 'picked', 'in_transit', 'delivered', 'cancelled', 'disputed')),
    pickup_location GEOGRAPHY(POINT, 4326),
    delivery_location GEOGRAPHY(POINT, 4326),
    pickup_time TIMESTAMP WITH TIME ZONE,
    delivery_time TIMESTAMP WITH TIME ZONE,
    special_instructions TEXT,
    qr_code VARCHAR(255) UNIQUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Routes table (optimized pickup/delivery routes)
CREATE TABLE routes (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    route_name VARCHAR(100) NOT NULL,
    agent_id UUID REFERENCES agents(id) ON DELETE CASCADE,
    route_date DATE NOT NULL,
    start_location GEOGRAPHY(POINT, 4326),
    end_location GEOGRAPHY(POINT, 4326),
    total_distance DECIMAL(10,2),
    estimated_duration INTEGER, -- in minutes
    status VARCHAR(20) DEFAULT 'planned' CHECK (status IN ('planned', 'active', 'completed', 'cancelled')),
    vehicle_type VARCHAR(50) NOT NULL,
    fuel_cost DECIMAL(10,2),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Route Orders (orders assigned to specific routes)
CREATE TABLE route_orders (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    route_id UUID REFERENCES routes(id) ON DELETE CASCADE,
    order_id UUID REFERENCES orders(id) ON DELETE CASCADE,
    sequence_number INTEGER NOT NULL,
    pickup_eta TIMESTAMP WITH TIME ZONE,
    delivery_eta TIMESTAMP WITH TIME ZONE,
    actual_pickup_time TIMESTAMP WITH TIME ZONE,
    actual_delivery_time TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(route_id, order_id)
);

-- Ratings table
CREATE TABLE ratings (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    order_id UUID REFERENCES orders(id) ON DELETE CASCADE,
    rated_by UUID REFERENCES users(id) ON DELETE CASCADE,
    rated_user UUID REFERENCES users(id) ON DELETE CASCADE,
    rating INTEGER NOT NULL CHECK (rating >= 1 AND rating <= 5),
    hygiene_rating INTEGER CHECK (hygiene_rating >= 1 AND hygiene_rating <= 5),
    quality_rating INTEGER CHECK (quality_rating >= 1 AND quality_rating <= 5),
    delivery_rating INTEGER CHECK (delivery_rating >= 1 AND delivery_rating <= 5),
    comments TEXT,
    images JSON,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Communications table (SMS/WhatsApp/IVR logs)
CREATE TABLE communications (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    type VARCHAR(20) NOT NULL CHECK (type IN ('sms', 'whatsapp', 'ivr', 'push')),
    direction VARCHAR(10) NOT NULL CHECK (direction IN ('inbound', 'outbound')),
    content TEXT NOT NULL,
    status VARCHAR(20) DEFAULT 'sent' CHECK (status IN ('sent', 'delivered', 'failed', 'read')),
    external_id VARCHAR(100),
    cost DECIMAL(8,4) DEFAULT 0,
    metadata JSON,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Payments table
CREATE TABLE payments (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    order_id UUID REFERENCES orders(id) ON DELETE CASCADE,
    farmer_id UUID REFERENCES farmers(id) ON DELETE CASCADE,
    amount DECIMAL(10,2) NOT NULL,
    payment_method VARCHAR(20) NOT NULL CHECK (payment_method IN ('upi', 'bank_transfer', 'cash')),
    transaction_id VARCHAR(100) UNIQUE,
    status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'failed', 'refunded')),
    processed_at TIMESTAMP WITH TIME ZONE,
    metadata JSON,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Disputes table
CREATE TABLE disputes (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    order_id UUID REFERENCES orders(id) ON DELETE CASCADE,
    raised_by UUID REFERENCES users(id) ON DELETE CASCADE,
    dispute_type VARCHAR(50) NOT NULL,
    description TEXT NOT NULL,
    evidence_images JSON,
    status VARCHAR(20) DEFAULT 'open' CHECK (status IN ('open', 'investigating', 'resolved', 'closed')),
    resolution TEXT,
    resolved_by UUID REFERENCES users(id),
    resolved_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Pickup Points table
CREATE TABLE pickup_points (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(100) NOT NULL,
    address TEXT NOT NULL,
    village VARCHAR(100) NOT NULL,
    district VARCHAR(100) NOT NULL,
    location GEOGRAPHY(POINT, 4326) NOT NULL,
    contact_person VARCHAR(100),
    contact_phone VARCHAR(15),
    operating_hours VARCHAR(50),
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Notifications table
CREATE TABLE notifications (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    title VARCHAR(200) NOT NULL,
    message TEXT NOT NULL,
    type VARCHAR(50) NOT NULL,
    data JSON,
    is_read BOOLEAN DEFAULT false,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Analytics Events table
CREATE TABLE analytics_events (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    event_type VARCHAR(100) NOT NULL,
    event_data JSON,
    ip_address INET,
    user_agent TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Create indexes for better performance
CREATE INDEX idx_users_phone ON users(phone_number);
CREATE INDEX idx_users_type ON users(user_type);
CREATE INDEX idx_farmers_location ON farmers USING GIST(location);
CREATE INDEX idx_vendors_location ON vendors USING GIST(location);
CREATE INDEX idx_agents_location ON agents USING GIST(current_location);
CREATE INDEX idx_orders_status ON orders(status);
CREATE INDEX idx_orders_created_at ON orders(created_at);
CREATE INDEX idx_product_listings_status ON product_listings(status);
CREATE INDEX idx_routes_date ON routes(route_date);
CREATE INDEX idx_ratings_order ON ratings(order_id);
CREATE INDEX idx_communications_user ON communications(user_id);
CREATE INDEX idx_communications_type ON communications(type);
CREATE INDEX idx_payments_status ON payments(status);
CREATE INDEX idx_disputes_status ON disputes(status);

-- Create triggers for updated_at timestamps
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_users_updated_at BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_farmers_updated_at BEFORE UPDATE ON farmers FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_vendors_updated_at BEFORE UPDATE ON vendors FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_agents_updated_at BEFORE UPDATE ON agents FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_product_listings_updated_at BEFORE UPDATE ON product_listings FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_orders_updated_at BEFORE UPDATE ON orders FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_routes_updated_at BEFORE UPDATE ON routes FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();