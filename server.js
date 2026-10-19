const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cors = require('cors');
const PDFDocument = require('pdfkit');
const cron = require('node-cron');
require('dotenv').config();

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

// 📊 Google Sheet URLs (Triple Sheets)
const GOOGLE_SHEET_SHIPPING_URL = 'https://docs.google.com/spreadsheets/d/1iWvwlNWxX9LV5AssmlMw-wYeF09ILncXamjulrdihDQ/export?format=csv';
const GOOGLE_SHEET_CUSTOMER_URL = 'https://docs.google.com/spreadsheets/d/165g39MP4HHIrMulhqM3Ot8isCrp5FP_0ZwtX8Aafg-A/export?format=csv';
const GOOGLE_SHEET_AMOUNT_URL = 'https://docs.google.com/spreadsheets/d/104cDSC0HcAr1S8zJQZhRITIdqNuBj1RUH9L1CYHOtJg/export?format=csv';

// 🏢 Warehouse Short Code to Full Name Mapping
const WAREHOUSE_MAP = {
    'LAK': 'Laksiri Warehouse in Peliyagoda',
    'NNR': 'NNR Peliyagoda',
    'CSL': 'CSL Cargo Warehouse',
    'TRN': 'Transco Warehouse',
    'SER': 'Ceylon Logistics Worldwide (Pvt) Ltd'
};

// Helper: Extract Warehouse Full Name
function extractWarehouseName(shipDateStr, arrDateStr, warehouseStr) {
    const combined = ((shipDateStr || '') + ' ' + (arrDateStr || '') + ' ' + (warehouseStr || '')).toUpperCase();
    for (const [code, fullName] of Object.entries(WAREHOUSE_MAP)) {
        if (combined.includes(code)) {
            return fullName;
        }
    }
    return warehouseStr || '';
}

// 🛡️ Proxy Trust Configuration
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

// 🛡️ Request Limits
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// 🛡️ Rate Limiting
const generalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, message: 'Too many requests from this IP. Please try again after 15 minutes.' }
});

const adminLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, message: 'Too many admin authorization attempts. Try again after 15 minutes.' }
});

app.use('/api/', generalLimiter);
app.use('/api/admin/', adminLimiter);

// Static Files
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
            customer_phone TEXT,
            shipping_date TEXT,
            arrival_date TEXT,
            clearing_warehouse TEXT,
            amount REAL DEFAULT 0,
            status TEXT,
            destination TEXT,
            whatsapp_sent INTEGER DEFAULT 0,
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

// 📲 Helper: Send WhatsApp Alert via UltraMsg API
async function sendWhatsAppAlert(customerPhone, customerName, invoiceNumber, status, arrivalDate) {
    if (!customerPhone) return;

    const cleanPhone = customerPhone.replace(/[^0-9]/g, '');
    if (cleanPhone.length < 9) return;

    const instanceId = process.env.ULTRAMSG_INSTANCE_ID;
    const token = process.env.ULTRAMSG_TOKEN;

    if (!instanceId || !token) {
        console.log("UltraMsg API credentials missing in environment variables.");
        return;
    }

    const messageText = `Hello ${customerName || 'Valued Customer'},\n\n` +
        `📦 *Cargo Shipment Arrival Notice*\n` +
        `• Invoice No: *${invoiceNumber}*\n` +
        `• Status: *${status || 'Arriving Today'}*\n` +
        `• Arrival Date: *${arrivalDate || 'Today'}*\n\n` +
        `🔗 Track live status at: https://tracking.otekexport.org\n\n` +
        `Thank you for choosing Otek Export & Panorama Cargo Logistics!`;

    try {
        const response = await fetch(`https://api.ultramsg.com/${instanceId}/messages/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                token: token,
                to: cleanPhone,
                body: messageText
            })
        });

        const data = await response.json();
        console.log(`WhatsApp Alert sent successfully to ${cleanPhone}:`, data);
    } catch (err) {
        console.error("WhatsApp API Send Error:", err.message);
    }
}

// 📊 Helper: Parse CSV Matrix
function parseCSVMatrix(text) {
    const lines = text.split(/\r?\n/);
    return lines.map(line => {
        const row = [];
        let insideQuote = false;
        let entry = '';
        for (let i = 0; i < line.length; i++) {
            const char = line[i];
            if (char === '"') {
                insideQuote = !insideQuote;
            } else if (char === ',' && !insideQuote) {
                row.push(entry.trim());
                entry = '';
            } else {
                entry += char;
            }
        }
        row.push(entry.trim());
        return row;
    });
}

// 🔄 Core Engine 1: Sync Shipping Sheet
async function syncShippingSheet() {
    console.log('🔄 Syncing Shipping Google Sheet...');
    try {
        const response = await fetch(GOOGLE_SHEET_SHIPPING_URL);
        if (!response.ok) throw new Error(`HTTP error! Status: ${response.status}`);
        
        const csvText = await response.text();
        const rows = parseCSVMatrix(csvText);

        if (rows.length < 4) return { success: false, message: 'Invalid shipping sheet format.' };

        const maxCols = Math.max(...rows.map(r => r.length));
        let count = 0;

        const query = `
            INSERT INTO cargo (invoice_number, shipping_date, arrival_date, clearing_warehouse, updated_at)
            VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(invoice_number) DO UPDATE SET
                shipping_date = CASE WHEN excluded.shipping_date != '' THEN excluded.shipping_date ELSE cargo.shipping_date END,
                arrival_date = CASE WHEN excluded.arrival_date != '' THEN excluded.arrival_date ELSE cargo.arrival_date END,
                clearing_warehouse = CASE WHEN excluded.clearing_warehouse != '' THEN excluded.clearing_warehouse ELSE cargo.clearing_warehouse END,
                updated_at = CURRENT_TIMESTAMP
        `;

        db.serialize(() => {
            db.run("BEGIN TRANSACTION");
            const stmt = db.prepare(query);

            for (let col = 0; col < maxCols; col++) {
                const shipDate = (rows[2] && rows[2][col]) ? rows[2][col].trim() : '';
                const rawArrDate = (rows[3] && rows[3][col]) ? rows[3][col].trim() : '';
                const warehouseName = extractWarehouseName(shipDate, rawArrDate, '');

                for (let r = 4; r < rows.length; r++) {
                    const inv = (rows[r] && rows[r][col]) ? rows[r][col].trim() : '';
                    if (inv && inv !== '' && inv.length >= 2) {
                        stmt.run([inv, shipDate, rawArrDate, warehouseName]);
                        count++;
                    }
                }
            }

            stmt.finalize();
            db.run("COMMIT");
        });

        console.log(`✅ Shipping Sheet Synced: ${count} records processed.`);
        return { success: true, count };
    } catch (err) {
        console.error("Shipping Sheet Sync Failed:", err.message);
        return { success: false, error: err.message };
    }
}

// 🔄 Core Engine 2: Sync Customer Details Sheet
async function syncCustomerSheet() {
    console.log('🔄 Syncing Customer Details Google Sheet...');
    try {
        const response = await fetch(GOOGLE_SHEET_CUSTOMER_URL);
        if (!response.ok) throw new Error(`HTTP error! Status: ${response.status}`);
        
        const csvText = await response.text();
        const rows = parseCSVMatrix(csvText);

        if (rows.length < 2) return { success: false, message: 'Customer sheet is empty.' };

        let count = 0;
        const query = `
            INSERT INTO cargo (invoice_number, customer_name, customer_phone, destination, updated_at)
            VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(invoice_number) DO UPDATE SET
                customer_name = CASE WHEN excluded.customer_name != '' THEN excluded.customer_name ELSE cargo.customer_name END,
                customer_phone = CASE WHEN excluded.customer_phone != '' THEN excluded.customer_phone ELSE cargo.customer_phone END,
                destination = CASE WHEN excluded.destination != '' THEN excluded.destination ELSE cargo.destination END,
                updated_at = CURRENT_TIMESTAMP
        `;

        db.serialize(() => {
            db.run("BEGIN TRANSACTION");
            const stmt = db.prepare(query);

            for (let r = 1; r < rows.length; r++) {
                const row = rows[r];
                const inv = row[0] ? row[0].trim() : '';
                const name = row[1] ? row[1].trim() : '';
                const phone = row[2] ? row[2].trim() : '';
                const dest = row[3] ? row[3].trim() : '';

                if (inv && inv !== '') {
                    stmt.run([inv, name, phone, dest]);
                    count++;
                }
            }

            stmt.finalize();
            db.run("COMMIT");
        });

        console.log(`✅ Customer Sheet Synced: ${count} records processed.`);
        return { success: true, count };
    } catch (err) {
        console.error("Customer Sheet Sync Failed:", err.message);
        return { success: false, error: err.message };
    }
}

// 🔄 Core Engine 3: Sync Have to Pay / Amount Sheet
async function syncAmountSheet() {
    console.log('🔄 Syncing Have to Pay / Amount Google Sheet...');
    try {
        const response = await fetch(GOOGLE_SHEET_AMOUNT_URL);
        if (!response.ok) throw new Error(`HTTP error! Status: ${response.status}`);
        
        const csvText = await response.text();
        const rows = parseCSVMatrix(csvText);

        if (rows.length < 2) return { success: false, message: 'Amount sheet is empty.' };

        let count = 0;
        const query = `
            INSERT INTO cargo (invoice_number, amount, updated_at)
            VALUES (?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(invoice_number) DO UPDATE SET
                amount = CASE WHEN excluded.amount > 0 THEN excluded.amount ELSE cargo.amount END,
                updated_at = CURRENT_TIMESTAMP
        `;

        db.serialize(() => {
            db.run("BEGIN TRANSACTION");
            const stmt = db.prepare(query);

            for (let r = 1; r < rows.length; r++) {
                const row = rows[r];
                const inv = row[0] ? row[0].trim() : '';
                let amt = 0;
                for (let c = 1; c < row.length; c++) {
                    const val = parseFloat(row[c].replace(/[^0-9.-]+/g, ""));
                    if (!isNaN(val) && val > 0) {
                        amt = val;
                        break;
                    }
                }

                if (inv && inv !== '') {
                    stmt.run([inv, amt]);
                    count++;
                }
            }

            stmt.finalize();
            db.run("COMMIT");
        });

        console.log(`✅ Amount Sheet Synced: ${count} records processed.`);
        return { success: true, count };
    } catch (err) {
        console.error("Amount Sheet Sync Failed:", err.message);
        return { success: false, error: err.message };
    }
}

// Combined Triple Sync Function
async function syncGoogleSheetData() {
    const res1 = await syncShippingSheet();
    const res2 = await syncCustomerSheet();
    const res3 = await syncAmountSheet();
    if (res1.success || res2.success || res3.success) {
        return { success: true, message: `Synced Shipping (${res1.count || 0}), Customer (${res2.count || 0}) & Amount (${res3.count || 0}) records successfully!` };
    }
    return { success: false, message: 'Google sheets sync failed.' };
}

// ⏰ Hourly Cron Job: Auto-Sync Google Sheets
cron.schedule('0 * * * *', () => {
    syncGoogleSheetData();
});

// ⏰ Daily Cron Job: Send Arrival WhatsApp Alerts at 09:00 AM
cron.schedule('0 9 * * *', () => {
    console.log('⏰ Running daily WhatsApp arrival check...');
    const today = new Date();
    const isoToday = today.toISOString().split('T')[0];
    const formattedToday = today.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });

    const query = `
        SELECT * FROM cargo 
        WHERE (arrival_date LIKE ? OR arrival_date LIKE ? OR arrival_date = ?) 
        AND (whatsapp_sent = 0 OR whatsapp_sent IS NULL)
    `;

    db.all(query, [`%${isoToday}%`, `%${formattedToday}%`, isoToday], (err, rows) => {
        if (err || !rows) return;
        rows.forEach((row) => {
            if (row.customer_phone) {
                sendWhatsAppAlert(row.customer_phone, row.customer_name, row.invoice_number, 'Arriving Today at Port ⚓', row.arrival_date);
                db.run("UPDATE cargo SET whatsapp_sent = 1 WHERE id = ?", [row.id]);
            }
        });
    });
});

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

        const resolvedWarehouse = extractWarehouseName(row.shipping_date, row.arrival_date, row.clearing_warehouse);
        if (resolvedWarehouse) {
            row.clearing_warehouse = resolvedWarehouse;
        }

        res.json({ success: true, data: row });
    });
});

// 📌 2. Admin Manual Sync Google Sheet Endpoint
app.post('/api/admin/sync-sheet', async (req, res) => {
    const { admin_password } = req.body;
    if (!checkAdminAuth(admin_password)) {
        return res.status(401).json({ success: false, message: 'Invalid Admin Password!' });
    }

    const result = await syncGoogleSheetData();
    if (result.success) {
        res.json({ success: true, message: result.message });
    } else {
        res.status(500).json({ success: false, message: `Sync Failed: ${result.error || result.message}` });
    }
});

// 📌 3. Admin Single Update Endpoint
app.post('/api/admin/update', (req, res) => {
    const { admin_password, invoice_number, customer_name, customer_phone, shipping_date, arrival_date, clearing_warehouse, amount, status, destination } = req.body;

    if (!checkAdminAuth(admin_password)) {
        return res.status(401).json({ success: false, message: 'Invalid Admin Password!' });
    }

    if (!invoice_number || !invoice_number.trim()) {
        return res.status(400).json({ success: false, message: 'Invoice Number is required.' });
    }

    const cleanInvoice = invoice_number.trim();
    const cleanAmount = parseFloat(amount) || 0;

    const query = `
        INSERT INTO cargo (invoice_number, customer_name, customer_phone, shipping_date, arrival_date, clearing_warehouse, amount, status, destination, whatsapp_sent, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, CURRENT_TIMESTAMP)
        ON CONFLICT(invoice_number) DO UPDATE SET
            customer_name = excluded.customer_name,
            customer_phone = excluded.customer_phone,
            shipping_date = excluded.shipping_date,
            arrival_date = excluded.arrival_date,
            clearing_warehouse = excluded.clearing_warehouse,
            amount = excluded.amount,
            status = excluded.status,
            destination = excluded.destination,
            whatsapp_sent = 0,
            updated_at = CURRENT_TIMESTAMP
    `;

    db.run(query, [cleanInvoice, customer_name, customer_phone, shipping_date, arrival_date, clearing_warehouse, cleanAmount, status, destination], function(err) {
        if (err) {
            console.error(err);
            return res.status(500).json({ success: false, message: 'Failed to update record.' });
        }

        if (customer_phone) {
            sendWhatsAppAlert(customer_phone, customer_name, cleanInvoice, status, arrival_date);
        }

        res.json({ success: true, message: `Record for ${cleanInvoice} updated successfully!` });
    });
});

// 📌 4. Admin Delete Endpoint
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

// 📌 5. Admin Bulk Update Endpoint (CSV Upload)
app.post('/api/admin/bulk-update', (req, res) => {
    const { admin_password, shipments } = req.body;

    if (!checkAdminAuth(admin_password)) {
        return res.status(401).json({ success: false, message: 'Invalid Admin Password!' });
    }

    if (!Array.isArray(shipments) || shipments.length === 0) {
        return res.status(400).json({ success: false, message: 'No valid shipment data provided.' });
    }

    const query = `
        INSERT INTO cargo (arrival_date, clearing_warehouse, invoice_number, customer_name, status, destination, amount, customer_phone, shipping_date, whatsapp_sent, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, CURRENT_TIMESTAMP)
        ON CONFLICT(invoice_number) DO UPDATE SET
            arrival_date = excluded.arrival_date,
            clearing_warehouse = excluded.clearing_warehouse,
            customer_name = excluded.customer_name,
            status = excluded.status,
            destination = excluded.destination,
            amount = excluded.amount,
            customer_phone = excluded.customer_phone,
            shipping_date = excluded.shipping_date,
            whatsapp_sent = 0,
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
                    amt,
                    item.customer_phone || '',
                    item.shipping_date || ''
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

// 📌 6. Admin Records Fetch Endpoint
app.get('/api/admin/records', (req, res) => {
    db.all("SELECT * FROM cargo ORDER BY updated_at DESC", [], (err, rows) => {
        if (err) {
            console.error(err);
            return res.status(500).json({ success: false, message: 'Server error retrieving records.' });
        }
        res.json({ success: true, data: rows || [] });
    });
});

// 📌 7. Stripe Checkout Session
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

// 📌 8. PDF Receipt Generator Endpoint
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

        const resolvedWarehouse = extractWarehouseName(row.shipping_date, row.arrival_date, row.clearing_warehouse) || row.clearing_warehouse || 'N/A';

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
        doc.text(`Customer Phone: ${row.customer_phone || 'N/A'}`);
        doc.text(`Destination: ${row.destination || 'N/A'}`);
        doc.text(`Clearing Warehouse: ${resolvedWarehouse}`);
        doc.text(`Shipping Date: ${row.shipping_date || 'N/A'}`);
        doc.text(`Arrival Date (ETA): ${row.arrival_date || 'N/A'}`);
        doc.text(`Status: ${row.status || 'Pending'}`);
        doc.moveDown(1.5);

        // Payment Details Breakdown
        doc.fillColor('#0369a1').fontSize(12).text('PAYMENT DETAILS BREAKDOWN', { bold: true });
        doc.moveDown(0.5);

        doc.fontSize(11).fillColor('#0f172a');
        doc.text(`Base Freight Charge (Have to Pay): ¥ ${baseAmount.toLocaleString()} JPY`);
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
    console.log(`Server running securely on port ${PORT} with Stable UI & Triple Sync`);
    syncGoogleSheetData();
});
