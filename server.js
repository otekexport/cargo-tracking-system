const express = require('express');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
require('dotenv').config();

// Render Environment Variables වලින් Stripe Secret Key එක ලබාගැනීම
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Database Setup (cargo.db)
const db = new sqlite3.Database(path.join(__dirname, 'cargo.db'), (err) => {
    if (err) {
        console.error('Database connection error:', err.message);
    } else {
        console.log('Connected to SQLite database (cargo.db).');
    }
});

// Table එක නැත්නම් නිර්මාණය කිරීම
db.run(`
    CREATE TABLE IF NOT EXISTS shipments (
        invoice_number TEXT PRIMARY KEY,
        customer_name TEXT,
        arrival_date TEXT,
        clearing_warehouse TEXT,
        amount REAL DEFAULT 0,
        status TEXT,
        destination TEXT
    )
`);

// ==========================================
// 1. PAGE ROUTES
// ==========================================
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/payment.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'payment.html'));
});

app.get('/records.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'records.html'));
});

// ==========================================
// 2. CARGO TRACKING API
// ==========================================
app.get('/api/track/:invoiceNumber', (req, res) => {
    const inv = req.params.invoiceNumber;
    db.get("SELECT * FROM shipments WHERE invoice_number = ?", [inv], (err, row) => {
        if (err) {
            return res.status(500).json({ success: false, message: 'Database error: ' + err.message });
        }
        if (!row) {
            return res.status(404).json({ success: false, message: 'Invoice number not found!' });
        }
        res.json({
            success: true,
            data: {
                arrival_date: row.arrival_date || '-',
                clearing_warehouse: row.clearing_warehouse || '-',
                invoice_number: row.invoice_number,
                customer_name: row.customer_name || '-',
                amount: row.amount || 0,
                status: row.status || 'In Transit',
                destination: row.destination || '-'
            }
        });
    });
});

// ==========================================
// 3. ADMIN APIS
// ==========================================

// Single Shipment Update
app.post('/api/admin/update', (req, res) => {
    const { admin_password, arrival_date, clearing_warehouse, invoice_number, customer_name, amount, status, destination } = req.body;

    if (admin_password !== ADMIN_PASSWORD) {
        return res.json({ success: false, message: 'Invalid Admin Password!' });
    }

    if (!invoice_number) {
        return res.json({ success: false, message: 'Invoice Number is required!' });
    }

    const query = `
        INSERT INTO shipments (invoice_number, customer_name, arrival_date, clearing_warehouse, amount, status, destination)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(invoice_number) DO UPDATE SET
            customer_name = excluded.customer_name,
            arrival_date = excluded.arrival_date,
            clearing_warehouse = excluded.clearing_warehouse,
            amount = excluded.amount,
            status = excluded.status,
            destination = excluded.destination
    `;

    db.run(query, [invoice_number, customer_name, arrival_date, clearing_warehouse, amount || 0, status, destination], function(err) {
        if (err) {
            return res.json({ success: false, message: 'Update failed: ' + err.message });
        }
        res.json({ success: true, message: 'Shipment updated successfully!' });
    });
});

// Single Shipment Delete
app.post('/api/admin/delete', (req, res) => {
    const { admin_password, invoice_number } = req.body;

    if (admin_password !== ADMIN_PASSWORD) {
        return res.json({ success: false, message: 'Invalid Admin Password!' });
    }

    if (!invoice_number) {
        return res.json({ success: false, message: 'Invoice Number is required!' });
    }

    db.run("DELETE FROM shipments WHERE invoice_number = ?", [invoice_number], function(err) {
        if (err) {
            return res.json({ success: false, message: 'Delete failed: ' + err.message });
        }
        res.json({ success: true, message: `Invoice ${invoice_number} deleted successfully!` });
    });
});

// Bulk CSV Upload
app.post('/api/admin/bulk-update', (req, res) => {
    const { admin_password, shipments } = req.body;

    if (admin_password !== ADMIN_PASSWORD) {
        return res.json({ success: false, message: 'Invalid Admin Password!' });
    }

    if (!shipments || !Array.isArray(shipments) || shipments.length === 0) {
        return res.json({ success: false, message: 'No shipments data provided!' });
    }

    db.serialize(() => {
        const stmt = db.prepare(`
            INSERT INTO shipments (invoice_number, customer_name, arrival_date, clearing_warehouse, amount, status, destination)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(invoice_number) DO UPDATE SET
                customer_name = excluded.customer_name,
                arrival_date = excluded.arrival_date,
                clearing_warehouse = excluded.clearing_warehouse,
                amount = excluded.amount,
                status = excluded.status,
                destination = excluded.destination
        `);

        shipments.forEach(s => {
            if (s.invoice_number) {
                stmt.run([
                    s.invoice_number,
                    s.customer_name || '',
                    s.arrival_date || '',
                    s.clearing_warehouse || '',
                    s.amount || 0,
                    s.status || '',
                    s.destination || ''
                ]);
            }
        });

        stmt.finalize((err) => {
            if (err) {
                return res.json({ success: false, message: 'Bulk update failed: ' + err.message });
            }
            res.json({ success: true, message: `Bulk update completed! (${shipments.length} records processed)` });
        });
    });
});

// All Records API
app.get('/api/admin/records', (req, res) => {
    db.all("SELECT * FROM shipments", [], (err, rows) => {
        if (err) {
            return res.status(500).json({ success: false, message: err.message });
        }
        res.json({ success: true, data: rows });
    });
});

// ==========================================
// 4. STRIPE PAYMENT CHECKOUT API
// ==========================================
const handleStripeCheckout = async (req, res) => {
    try {
        // Frontend එකෙන් එන ඕනෑම variable නමක් හඳුනාගැනීම
        const trackingNumber = req.body.trackingNumber || req.body.tracking || req.body.invoice_number || 'N/A';
        const customerName = req.body.customerName || req.body.customer_name || req.body.name || 'Customer';
        const rawAmount = req.body.amount || req.body.chargeAmount || 0;
        const amount = parseInt(rawAmount);

        if (!amount || amount <= 0) {
            return res.status(400).json({ success: false, error: 'Valid payment amount is required.' });
        }

        if (!process.env.STRIPE_SECRET_KEY) {
            return res.status(500).json({ success: false, error: 'Stripe Secret Key is missing in Render Environment Variables!' });
        }

        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            line_items: [
                {
                    price_data: {
                        currency: 'jpy',
                        product_data: {
                            name: `Cargo Freight Invoice: ${trackingNumber}`,
                            description: `Customer: ${customerName} | Invoice: ${trackingNumber}`,
                        },
                        unit_amount: amount,
                    },
                    quantity: 1,
                },
            ],
            mode: 'payment',
            success_url: `${req.protocol}://${req.get('host')}/payment.html?status=success&tracking=${encodeURIComponent(trackingNumber)}`,
            cancel_url: `${req.protocol}://${req.get('host')}/payment.html?status=cancelled&tracking=${encodeURIComponent(trackingNumber)}&amount=${amount}&name=${encodeURIComponent(customerName)}`,
        });

        res.json({ success: true, url: session.url });
    } catch (error) {
        console.error('Stripe Checkout Error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
};

// Route 2 කටම සෙට් කර ඇත (Mismatches වළක්වා ගැනීමට)
app.post('/create-checkout-session', handleStripeCheckout);
app.post('/api/create-checkout-session', handleStripeCheckout);

// ==========================================
// 5. SERVER START
// ==========================================
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
