const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cors = require('cors');
const PDFDocument = require('pdfkit');
require('dotenv').config();

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

// 🛡️ Proxy Trust Configuration (Render / Cloudflare IP Protection)
app.set('trust proxy', 1);

// 🛡️ Security Headers
app.use(helmet({
    contentSecurityPolicy: false,
    strictTransportSecurity: {
        maxAge: 31536000,
        includeSubDomains: true,
        preload: true
    }
}));

app.use(cors());

// 🛡️ Request Payload Size Limits
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// 🛡️ Rate Limiting: General Public API
const generalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, message: 'Too many requests from this IP. Please try again after 15 minutes.' }
});

// 🛡️ Rate Limiting: Admin Brute-Force Protection
const adminLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, message: 'Too many admin authorization attempts. Try again after 15 minutes.' }
});

app.use('/api/', generalLimiter);
app.use('/api/admin/', adminLimiter);

// Serve Static Files
app.use(express.static(path.join(__dirname, 'public')));

// Database Connection
const db = new sqlite3.Database('./cargo.db', (err) => {
    if (err) {
        console.error('Database connection error:', err.message);
    } else {
        console.log('Connected securely to SQLite database.');
    }
});

// Database Table Schema Setup
db.serialize(() => {
    db.run(`
        CREATE TABLE IF NOT EXISTS cargo (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            invoice_number TEXT UNIQUE NOT NULL,
            customer_name TEXT,
            arrival_date TEXT,
            clearing_warehouse TEXT,
            amount REAL DEFAULT 0,
            status TEXT,
            destination TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);
});

// Helper: Secure Admin Auth Check
function checkAdminAuth(reqPassword) {
    if (!ADMIN_PASSWORD) return false;
    return reqPassword === ADMIN_PASSWORD;
}

// 📌 1. Track Cargo Endpoint
app.get('/api/track/:invoice', (req, res) => {
    const invoice = req.params.invoice ? req.params.invoice.trim() : '';
    if (!invoice) {
        return res.status(400).json({ success: false, message: 'Invoice number is required.' });
    }

    db.get("SELECT * FROM cargo WHERE invoice_number = ?", [invoice], (err, row) => {
        if (err) {
            console.error(err);
            return res.status(500).json({ success: false, message: 'Server error retrieving record.' });
        }
        if (!row) {
            return res.status(404).json({ success: false, message: 'Invoice number not found. Please double check.' });
        }
        res.json({ success: true, data: row });
    });
});

// 📌 2. Admin Update Endpoint
app.post('/api/admin/update', (req, res) => {
    const { admin_password, invoice_number, customer_name, arrival_date, clearing_warehouse, amount, status, destination } = req.body;

    if (!checkAdminAuth(admin_password)) {
        return res.status(401).json({ success: false, message: 'Invalid Admin Password!' });
    }

    if (!invoice_number || !invoice_number.trim()) {
        return res.status(400).json({ success: false, message: 'Invoice Number is required.' });
    }

    const cleanInvoice = invoice_number.trim();
    const cleanAmount = parseFloat(amount) || 0;

    const query = `
        INSERT INTO cargo (invoice_number, customer_name, arrival_date, clearing_warehouse, amount, status, destination, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(invoice_number) DO UPDATE SET
            customer_name = excluded.customer_name,
            arrival_date = excluded.arrival_date,
            clearing_warehouse = excluded.clearing_warehouse,
            amount = excluded.amount,
            status = excluded.status,
            destination = excluded.destination,
            updated_at = CURRENT_TIMESTAMP
    `;

    db.run(query, [cleanInvoice, customer_name, arrival_date, clearing_warehouse, cleanAmount, status, destination], function(err) {
        if (err) {
            console.error(err);
            return res.status(500).json({ success: false, message: 'Failed to update record.' });
        }
        res.json({ success: true, message: `Record for ${cleanInvoice} updated successfully!` });
    });
});

// 📌 3. Admin Delete Endpoint
app.post('/api/admin/delete', (req, res) => {
    const { admin_password, invoice_number } = req.body;

    if (!checkAdminAuth(admin_password)) {
        return res.status(401).json({ success: false, message: 'Invalid Admin Password!' });
    }

    if (!invoice_number || !invoice_number.trim()) {
        return res.status(400).json({ success: false, message: 'Invoice Number is required.' });
    }

    db.run("DELETE FROM cargo WHERE invoice_number = ?", [invoice_number.trim()], function(err) {
        if (err) {
            console.error(err);
            return res.status(500).json({ success: false, message: 'Failed to delete record.' });
        }
        if (this.changes === 0) {
            return res.status(404).json({ success: false, message: 'Record not found.' });
        }
        res.json({ success: true, message: `Invoice ${invoice_number} deleted successfully!` });
    });
});

// 📌 4. Admin Bulk Update Endpoint
app.post('/api/admin/bulk-update', (req, res) => {
    const { admin_password, shipments } = req.body;

    if (!checkAdminAuth(admin_password)) {
        return res.status(401).json({ success: false, message: 'Invalid Admin Password!' });
    }

    if (!Array.isArray(shipments) || shipments.length === 0) {
        return res.status(400).json({ success: false, message: 'No valid shipment data provided.' });
    }

    const query = `
        INSERT INTO cargo (arrival_date, clearing_warehouse, invoice_number, customer_name, status, destination, amount, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(invoice_number) DO UPDATE SET
            arrival_date = excluded.arrival_date,
            clearing_warehouse = excluded.clearing_warehouse,
            customer_name = excluded.customer_name,
            status = excluded.status,
            destination = excluded.destination,
            amount = excluded.amount,
            updated_at = CURRENT_TIMESTAMP
    `;

    db.serialize(() => {
        db.run("BEGIN TRANSACTION");
        const stmt = db.prepare(query);
        let updatedCount = 0;

        shipments.forEach((item) => {
            if (item.invoice_number && item.invoice_number.trim()) {
                const amt = parseFloat(item.amount) || 0;
                stmt.run([
                    item.arrival_date || '',
                    item.clearing_warehouse || '',
                    item.invoice_number.trim(),
                    item.customer_name || '',
                    item.status || '',
                    item.destination || '',
                    amt
                ]);
                updatedCount++;
            }
        });

        stmt.finalize();
        db.run("COMMIT", (err) => {
            if (err) {
                console.error(err);
                return res.status(500).json({ success: false, message: 'Bulk upload failed.' });
            }
            res.json({ success: true, message: `Successfully updated ${updatedCount} cargo records!` });
        });
    });
});

// 📌 5. Admin Records Fetch Endpoint
app.get('/api/admin/records', (req, res) => {
    db.all("SELECT * FROM cargo ORDER BY updated_at DESC", [], (err, rows) => {
        if (err) {
            console.error(err);
            return res.status(500).json({ success: false, message: 'Server error retrieving records.' });
        }
        res.json({ success: true, data: rows || [] });
    });
});

// 📌 6. Stripe Checkout Session (4.2% Processing Fee Included)
app.post('/create-checkout-session', (req, res) => {
    const { trackingNumber, customerName, customerEmail, customAmount } = req.body;

    if (!trackingNumber) {
        return res.status(400).json({ error: 'Invoice number is required.' });
    }

    db.get("SELECT amount FROM cargo WHERE invoice_number = ?", [trackingNumber.trim()], async (err, row) => {
        let baseAmount = 0;

        if (row && parseFloat(row.amount) > 0) {
            baseAmount = parseFloat(row.amount);
        } else if (customAmount && parseFloat(customAmount) > 0) {
            baseAmount = parseFloat(customAmount);
        }

        if (baseAmount <= 0) {
            return res.status(400).json({ error: 'Valid invoice amount not found.' });
        }

        // 💳 Server-Side 4.2% Processing Fee & Tax Calculation
        const cardFeeRate = 0.042;
        const cardFee = Math.round(baseAmount * cardFeeRate);
        const totalAmount = baseAmount + cardFee;

        try {
            const session = await stripe.checkout.sessions.create({
                payment_method_types: ['card'],
                line_items: [
                    {
                        price_data: {
                            currency: 'jpy',
                            product_data: {
                                name: `Otek Export Freight Payment - ${trackingNumber.trim()}`,
                                description: `Freight Amount: ¥${baseAmount.toLocaleString()} JPY | Card Processing & Service Fee (4.2%): ¥${cardFee.toLocaleString()} JPY`,
                            },
                            unit_amount: totalAmount,
                        },
                        quantity: 1,
                    },
                ],
                mode: 'payment',
                customer_email: customerEmail || undefined,
                success_url: `${req.protocol}://${req.get('host')}/payment.html?status=success&tracking=${encodeURIComponent(trackingNumber)}`,
                cancel_url: `${req.protocol}://${req.get('host')}/payment.html?status=cancelled&tracking=${encodeURIComponent(trackingNumber)}`,
            });

            res.json({ url: session.url });
        } catch (error) {
            console.error("Stripe Checkout Error:", error);
            res.status(500).json({ error: error.message });
        }
    });
});

// 📌 7. PDF Receipt Generator Endpoint
app.get('/api/download-receipt/:invoice', (req, res) => {
    const invoice = req.params.invoice ? req.params.invoice.trim() : '';
    if (!invoice) {
        return res.status(400).send('Invoice number is required.');
    }

    db.get("SELECT * FROM cargo WHERE invoice_number = ?", [invoice], (err, row) => {
        if (err || !row) {
            return res.status(404).send('Invoice record not found.');
        }

        const baseAmount = parseFloat(row.amount) || 0;
        const cardFee = Math.round(baseAmount * 0.042);
        const totalAmount = baseAmount + cardFee;

        const doc = new PDFDocument({ size: 'A4', margin: 50 });

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename=Otek_Receipt_${invoice}.pdf`);

        doc.pipe(res);

        // Header / Branding
        doc.fillColor('#0284c7').fontSize(22).text('OTEK EXPORT', { align: 'center', bold: true });
        doc.fillColor('#475569').fontSize(10).text('Panorama Cargo Logistics (Pvt) Ltd', { align: 'center' });
        doc.moveDown(0.5);
        doc.fillColor('#0f172a').fontSize(14).text('OFFICIAL FREIGHT INVOICE & RECEIPT', { align: 'center', underline: true });
        doc.moveDown(1);

        doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor('#cbd5e1').stroke();
        doc.moveDown(1);

        // Shipment Details
        doc.fontSize(11).fillColor('#334155');
        doc.text(`Receipt Date: ${new Date().toLocaleDateString()}`);
        doc.text(`Invoice / Tracking No: ${row.invoice_number}`);
        doc.text(`Customer Name: ${row.customer_name || 'N/A'}`);
        doc.text(`Destination: ${row.destination || 'N/A'}`);
        doc.text(`Clearing Warehouse: ${row.clearing_warehouse || 'N/A'}`);
        doc.text(`Arrival Date: ${row.arrival_date || 'N/A'}`);
        doc.text(`Status: ${row.status || 'Pending'}`);
        doc.moveDown(1.5);

        // Payment Details Breakdown
        doc.fillColor('#0369a1').fontSize(12).text('PAYMENT DETAILS BREAKDOWN', { bold: true });
        doc.moveDown(0.5);

        doc.fontSize(11).fillColor('#0f172a');
        doc.text(`Base Freight Charge: ¥ ${baseAmount.toLocaleString()} JPY`);
        doc.text(`Card Processing & Service Fee (4.2%): ¥ ${cardFee.toLocaleString()} JPY`);
        
        doc.moveDown(0.5);
        doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor('#0284c7').stroke();
        doc.moveDown(0.5);

        doc.fontSize(13).fillColor('#15803d').text(`Total Amount Paid / Payable: ¥ ${totalAmount.toLocaleString()} JPY`, { bold: true });

        doc.moveDown(3);
        doc.fontSize(8).fillColor('#64748b').text('Notice: Arrival dates and schedules are updated based on real-time data provided by shipping lines and may be subject to minor changes due to weather and port operations.', { align: 'center' });
        doc.moveDown(0.5);
        doc.text('Thank you for choosing Otek Export & Panorama Cargo Logistics!', { align: 'center', bold: true });

        doc.end();
    });
});

app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
    console.log(`Server running securely on port ${PORT} with 4.2% Card Fee & PDF Receipt Engine`);
});
