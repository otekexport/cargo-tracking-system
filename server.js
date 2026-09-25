const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bodyParser = require('body-parser');
const path = require('path');

// Stripe SDK Initialization
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY || 'sk_test_YOUR_SECRET_KEY_HERE');

const app = express();
const PORT = process.env.PORT || 3000;

// Admin Password Configuration
const ADMIN_PASSWORD = 'admin123';

app.use(bodyParser.json({ limit: '15mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// SQLite Database Setup
const db = new sqlite3.Database(path.join(__dirname, 'cargo.db'), (err) => {
    if (err) console.error(err.message);
    console.log('Database connected successfully.');
});

// Create Table & Safely Add Columns
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS shipments (
        invoice_number TEXT PRIMARY KEY,
        customer_name TEXT,
        status TEXT,
        destination TEXT,
        updated_at TEXT
    )`);

    db.run(`ALTER TABLE shipments ADD COLUMN arrival_date TEXT`, (err) => {});
    db.run(`ALTER TABLE shipments ADD COLUMN clearing_warehouse TEXT`, (err) => {});
    db.run(`ALTER TABLE shipments ADD COLUMN payment_status TEXT`, (err) => {});
    db.run(`ALTER TABLE shipments ADD COLUMN payment_slip TEXT`, (err) => {});
    db.run(`ALTER TABLE shipments ADD COLUMN amount REAL`, (err) => {});
});

// Customer Track API
app.get('/api/track/:invoice', (req, res) => {
    const invoice = req.params.invoice;
    db.get('SELECT * FROM shipments WHERE invoice_number = ?', [invoice], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (row) {
            res.json({ success: true, data: row });
        } else {
            res.json({ success: false, message: 'Invoice Number එක හමු වූයේ නැත!' });
        }
    });
});

// 💳 Stripe Online Card Payment Checkout Session API
app.post('/api/create-checkout-session', async (req, res) => {
    try {
        const { invoice_number, amount, customer_name, currency } = req.body;

        const payAmount = Number(amount) || 0;
        if (payAmount <= 0) {
            return res.status(400).json({ success: false, message: 'අදාළ Invoice එක සඳහා ගෙවිය යුතු මුදලක් (Amount) සඳහන් කර නැත.' });
        }

        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            line_items: [
                {
                    price_data: {
                        currency: currency || 'jpy', // JPY, USD, or LKR
                        product_data: {
                            name: `Cargo Invoice: ${invoice_number}`,
                            description: `Customer: ${customer_name}`,
                        },
                        unit_amount: Math.round(payAmount * (currency === 'jpy' ? 1 : 100)),
                    },
                    quantity: 1,
                },
            ],
            mode: 'payment',
            client_reference_id: invoice_number,
            success_url: `https://${req.headers.host}/success.html?inv=${invoice_number}`,
            cancel_url: `https://${req.headers.host}/cancel.html`,
        });

        res.json({ success: true, url: session.url });
    } catch (error) {
        console.error('Stripe Checkout Error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// Admin Single Update API
app.post('/api/admin/update', (req, res) => {
    const { admin_password, arrival_date, clearing_warehouse, invoice_number, customer_name, status, destination, amount } = req.body;

    if (admin_password !== ADMIN_PASSWORD) {
        return res.json({ success: false, message: 'Invalid Admin Password!' });
    }

    const date = new Date().toLocaleString();

    const query = `INSERT INTO shipments (invoice_number, arrival_date, clearing_warehouse, customer_name, status, destination, amount, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                   ON CONFLICT(invoice_number) DO UPDATE SET
                   arrival_date = excluded.arrival_date,
                   clearing_warehouse = excluded.clearing_warehouse,
                   customer_name = excluded.customer_name,
                   status = excluded.status,
                   destination = excluded.destination,
                   amount = excluded.amount,
                   updated_at = excluded.updated_at`;

    db.run(query, [invoice_number, arrival_date, clearing_warehouse, customer_name, status, destination, amount || 0, date], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true, message: 'Shipment updated successfully!' });
    });
});

// Admin Single Delete API
app.post('/api/admin/delete', (req, res) => {
    const { admin_password, invoice_number } = req.body;

    if (admin_password !== ADMIN_PASSWORD) {
        return res.json({ success: false, message: 'Invalid Admin Password!' });
    }

    if (!invoice_number) {
        return res.json({ success: false, message: 'Invoice Number is required!' });
    }

    db.run('DELETE FROM shipments WHERE invoice_number = ?', [invoice_number], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        if (this.changes === 0) {
            return res.json({ success: false, message: 'Invoice Number not found in database!' });
        }
        res.json({ success: true, message: `Invoice ${invoice_number} successfully deleted!` });
    });
});

// Admin Multiple Delete API
app.post('/api/admin/delete-multiple', (req, res) => {
    const { admin_password, invoice_numbers } = req.body;

    if (admin_password !== ADMIN_PASSWORD) {
        return res.json({ success: false, message: 'Invalid Admin Password!' });
    }

    if (!Array.isArray(invoice_numbers) || invoice_numbers.length === 0) {
        return res.json({ success: false, message: 'Select at least one record to delete!' });
    }

    const placeholders = invoice_numbers.map(() => '?').join(',');
    const query = `DELETE FROM shipments WHERE invoice_number IN (${placeholders})`;

    db.run(query, invoice_numbers, function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true, message: `${this.changes} Record(s) successfully deleted!` });
    });
});

// Admin Get All Records API
app.post('/api/admin/all', (req, res) => {
    const { admin_password } = req.body;

    if (admin_password !== ADMIN_PASSWORD) {
        return res.json({ success: false, message: 'Invalid Admin Password!' });
    }

    db.all('SELECT * FROM shipments ORDER BY rowid DESC', [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true, data: rows });
    });
});

// Admin Bulk Upload API
app.post('/api/admin/bulk-update', (req, res) => {
    const { admin_password, shipments } = req.body;

    if (admin_password !== ADMIN_PASSWORD) {
        return res.json({ success: false, message: 'Invalid Admin Password!' });
    }

    if (!Array.isArray(shipments) || shipments.length === 0) {
        return res.json({ success: false, message: 'No valid shipments data provided!' });
    }

    const date = new Date().toLocaleString();
    const query = `INSERT INTO shipments (invoice_number, arrival_date, clearing_warehouse, customer_name, status, destination, amount, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                   ON CONFLICT(invoice_number) DO UPDATE SET
                   arrival_date = excluded.arrival_date,
                   clearing_warehouse = excluded.clearing_warehouse,
                   customer_name = excluded.customer_name,
                   status = excluded.status,
                   destination = excluded.destination,
                   amount = excluded.amount,
                   updated_at = excluded.updated_at`;

    db.serialize(() => {
        db.run('BEGIN TRANSACTION');
        const stmt = db.prepare(query, (err) => {
            if (err) console.error("Prepare Error:", err);
        });

        shipments.forEach(item => {
            if (item.invoice_number) {
                stmt.run([
                    item.invoice_number,
                    item.arrival_date || '',
                    item.clearing_warehouse || '',
                    item.customer_name || '',
                    item.status || '',
                    item.destination || '',
                    item.amount || 0,
                    date
                ]);
            }
        });

        stmt.finalize();

        db.run('COMMIT', (err) => {
            if (err) return res.status(500).json({ success: false, message: err.message });
            res.json({ success: true, message: `${shipments.length} Cargo records successfully updated in bulk!` });
        });
    });
});

app.listen(PORT, () => {
    console.log('Server is running at port ' + PORT);
});
