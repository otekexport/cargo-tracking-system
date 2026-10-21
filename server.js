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

// 📊 Google Sheet URLs
const GOOGLE_SHEET_SHIPPING_URL = 'https://docs.google.com/spreadsheets/d/1iWvwlNWxX9LV5AssmlMw-wYeF09ILncXamjulrdihDQ/export?format=csv';
const GOOGLE_SHEET_CUSTOMER_URL = 'https://docs.google.com/spreadsheets/d/165g39MP4HHIrMulhqM3Ot8isCrp5FP_0ZwtX8Aafg-A/export?format=csv&gid=757565291';
const GOOGLE_SHEET_AMOUNT_URL = 'https://docs.google.com/spreadsheets/d/104cDSC0HcAr1S8zJQZhRITIdqNuBj1RUH9L1CYHOtJg/export?format=csv';

const WAREHOUSE_MAP = {
    'LAK': 'Laksiri Warehouse in Peliyagoda',
    'NNR': 'NNR Peliyagoda',
    'CSL': 'CSL Cargo Warehouse',
    'TRN': 'Transco Warehouse',
    'SER': 'Ceylon Logistics Worldwide (Pvt) Ltd'
};

function extractWarehouseName(shipDateStr, arrDateStr, warehouseStr) {
    const combined = ((shipDateStr || '') + ' ' + (arrDateStr || '') + ' ' + (warehouseStr || '')).toUpperCase();
    for (const [code, fullName] of Object.entries(WAREHOUSE_MAP)) {
        if (combined.includes(code)) {
            return fullName;
        }
    }
    return warehouseStr || '';
}

app.set('trust proxy', 1);

app.use(helmet({
    contentSecurityPolicy: false,
    strictTransportSecurity: { maxAge: 31536000, includeSubDomains: true, preload: true }
}));

app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

const generalLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 100 });
const adminLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10 });

app.use('/api/', generalLimiter);
app.use('/api/admin/', adminLimiter);
app.use(express.static(path.join(__dirname, 'public')));

const db = new sqlite3.Database('./cargo.db', (err) => {
    if (err) console.error('Database connection error:', err.message);
    else console.log('Connected securely to SQLite database.');
});

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
            full_price REAL DEFAULT 0,
            status TEXT,
            destination TEXT,
            whatsapp_sent INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);
});

function checkAdminAuth(reqPassword) {
    if (!ADMIN_PASSWORD) return false;
    return reqPassword === ADMIN_PASSWORD;
}

async function sendWhatsAppAlert(customerPhone, customerName, invoiceNumber, status, arrivalDate) {
    if (!customerPhone) {
        console.log("WhatsApp Error: Customer phone is empty for invoice:", invoiceNumber);
        return;
    }
    const cleanPhone = customerPhone.replace(/[^0-9]/g, '');
    if (cleanPhone.length < 9) {
        console.log("WhatsApp Error: Invalid phone number length:", customerPhone);
        return;
    }

    const instanceId = process.env.ULTRAMSG_INSTANCE_ID;
    const token = process.env.ULTRAMSG_TOKEN;
    if (!instanceId || !token) {
        console.log("WhatsApp Error: Instance ID or Token is missing in .env file!");
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
            body: new URLSearchParams({ token: token, to: cleanPhone, body: messageText })
        });
        const resultText = await response.text();
        console.log(`WhatsApp API Response for ${cleanPhone}:`, resultText);
    } catch (err) {
        console.error("WhatsApp API Network Error:", err.message);
    }
}

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

async function syncShippingSheet() {
    try {
        const response = await fetch(GOOGLE_SHEET_SHIPPING_URL);
        if (!response.ok) return { success: false };
        const csvText = await response.text();
        const rows = parseCSVMatrix(csvText);
        if (rows.length < 4) return { success: false };

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
                    if (inv && inv.length >= 2) {
                        stmt.run([inv, shipDate, rawArrDate, warehouseName]);
                        count++;
                    }
                }
            }
            stmt.finalize();
            db.run("COMMIT");
        });
        return { success: true, count };
    } catch (err) {
        return { success: false, error: err.message };
    }
}

async function syncCustomerSheet() {
    try {
        const response = await fetch(GOOGLE_SHEET_CUSTOMER_URL);
        if (!response.ok) return { success: false };
        const csvText = await response.text();
        
        const lines = csvText.split(/\r?\n/);
        if (lines.length < 2) return { success: false };

        let count = 0;
        const query = `
            INSERT INTO cargo (invoice_number, customer_name, customer_phone, destination, updated_at)
            VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(invoice_number) DO UPDATE SET
                customer_name = COALESCE(NULLIF(cargo.customer_name, ''), excluded.customer_name),
                customer_phone = COALESCE(NULLIF(cargo.customer_phone, ''), excluded.customer_phone),
                destination = COALESCE(NULLIF(cargo.destination, ''), excluded.destination),
                updated_at = CURRENT_TIMESTAMP
        `;

        db.serialize(() => {
            db.run("BEGIN TRANSACTION");
            const stmt = db.prepare(query);
            
            for (let r = 1; r < lines.length; r++) {
                const line = lines[r].trim();
                if (!line) continue;

                const cols = line.split(/,(?=(?:(?:[^"]*"){2})*[^"]*$)/).map(c => c.trim().replace(/^["']\vert{}["']$/g, ''));
                if (cols.length === 0) continue;

                const fullLineStr = cols.join(' ');

                // 1. Invoice Number එක සොයා ගැනීම
                let inv = '';
                const invMatch = fullLineStr.match(/\b(INV-?[0-9]+|[0-9]{4,6})\b/i);
                if (invMatch) inv = invMatch[0].trim();
                if (!inv && cols[14]) inv = cols[14].trim();
                if (!inv) continue;

                // 2. Column W (Index 22 හෝ 23) හෝ පේළියේ වෙනත් තැනක ඇති නම
                let name = '';
                if (cols[22] && cols[22].trim()) name = cols[22].trim();
                else if (cols[23] && cols[23].trim()) name = cols[23].trim();
                else if (cols[21] && cols[21].trim()) name = cols[21].trim();

                // 3. Column Z (Index 25 හෝ 26) හෝ පේළියේ ඇති දුරකථන අංකය
                let phone = '';
                let rawPhone = '';
                if (cols[25] && cols[25].trim()) rawPhone = cols[25];
                else if (cols[26] && cols[26].trim()) rawPhone = cols[26];
                else {
                    const phoneMatch = fullLineStr.match(/(\+?[0-9]{10,14})/);
                    if (phoneMatch) rawPhone = phoneMatch[0];
                }
                if (rawPhone) {
                    phone = rawPhone.replace(/[^0-9]/g, '');
                }

                // 4. Column AH (Index 33 හෝ 34) හෝ පේළියේ ඇති Destination එක
                let dest = '';
                if (cols[33] && cols[33].trim()) dest = cols[33].trim();
                else if (cols[34] && cols[34].trim()) dest = cols[34].trim();
                else if (cols[32] && cols[32].trim()) dest = cols[32].trim();

                // වෙනත් කොලම් වලින් හරි ගස්සා ගැනීම (Fallback: W, Z, AH හි ඩේටා නැත්නම් ලූප් කර හොයාගැනීම)
                if (!name || !phone || !dest) {
                    for (let i = 0; i < cols.length; i++) {
                        const val = cols[i] ? cols[i].trim() : '';
                        if (!val) continue;
                        
                        // Phone
                        const cleanNum = val.replace(/[^0-9]/g, '');
                        if (!phone && cleanNum.length >= 9 && cleanNum.length <= 14) {
                            phone = cleanNum;
                            continue;
                        }
                        // Destination
                        const lv = val.toLowerCase();
                        if (!dest && (lv.includes('colombo') || lv.includes('kandy') || lv.includes('galle') || lv.includes('jaffna') || lv.includes('negombo') || lv.includes('gampaha'))) {
                            dest = val;
                            continue;
                        }
                        // Name
                        if (!name && i > 5 && val.length > 2 && !val.match(/^[0-9]+$/) && !lv.includes('http') && !lv.includes('inv')) {
                            name = val;
                        }
                    }
                }

                if (inv && inv !== '') {
                    stmt.run([inv, name, phone, dest]);
                    count++;
                }
            }
            stmt.finalize();
            db.run("COMMIT");
        });
        return { success: true, count };
    } catch (err) {
        return { success: false, error: err.message };
    }
}
async function syncAmountSheet() {
    try {
        const response = await fetch(GOOGLE_SHEET_AMOUNT_URL);
        if (!response.ok) return { success: false };
        const csvText = await response.text();
        const rows = parseCSVMatrix(csvText);
        if (rows.length < 2) return { success: false };

        let count = 0;
        const query = `
            INSERT INTO cargo (invoice_number, amount, full_price, updated_at)
            VALUES (?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(invoice_number) DO UPDATE SET
                amount = CASE WHEN excluded.amount > 0 THEN excluded.amount ELSE cargo.amount END,
                full_price = CASE WHEN excluded.full_price > 0 THEN excluded.full_price ELSE cargo.full_price END,
                updated_at = CURRENT_TIMESTAMP
        `;

        db.serialize(() => {
            db.run("BEGIN TRANSACTION");
            const stmt = db.prepare(query);
            for (let r = 1; r < rows.length; r++) {
                const row = rows[r];
                const inv = (row[0] !== undefined) ? row[0].trim() : '';
                
                let amt = 0;
                if (row[10] !== undefined) {
                    const val = parseFloat(row[10].toString().replace(/[^0-9.-]+/g, ""));
                    if (!isNaN(val)) amt = val;
                }

                let fullPrice = 0;
                if (row[5] !== undefined) {
                    const valF = parseFloat(row[5].toString().replace(/[^0-9.-]+/g, ""));
                    if (!isNaN(valF)) fullPrice = valF;
                }
                if (fullPrice === 0 && amt > 0) fullPrice = amt;

                if (inv && inv !== '') {
                    stmt.run([inv, amt, fullPrice]);
                    count++;
                }
            }
            stmt.finalize();
            db.run("COMMIT");
        });
        return { success: true, count };
    } catch (err) {
        return { success: false, error: err.message };
    }
}

async function syncGoogleSheetData() {
    const res1 = await syncShippingSheet();
    const res2 = await syncCustomerSheet();
    const res3 = await syncAmountSheet();
    if (res1.success || res2.success || res3.success) {
        return { success: true, message: `Synced successfully!` };
    }
    return { success: false, message: 'Google sheets sync failed.' };
}

cron.schedule('0 * * * *', () => { syncGoogleSheetData(); });

// 📊 Admin: Heta ETA eka thiyana invoice list eka pennana API eka
app.post('/api/admin/tomorrow-eta-list', (req, res) => {
    const { admin_password } = req.body;
    if (!checkAdminAuth(admin_password)) {
        return res.status(401).json({ success: false, message: 'Invalid Admin Password!' });
    }

    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    
    const year = tomorrow.getFullYear();
    const month = String(tomorrow.getMonth() + 1).padStart(2, '0');
    const day = String(tomorrow.getDate()).padStart(2, '0');
    
    const dateStr1 = `${year}/${month}/${day}`;
    const dateStr2 = `${year}-${month}-${day}`;

    const query = `
        SELECT * FROM cargo 
        WHERE arrival_date LIKE ? 
           OR arrival_date LIKE ?
    `;

    db.all(query, [`%${dateStr1}%`, `%${dateStr2}%`], (err, rows) => {
        if (err) return res.status(500).json({ success: false, message: 'Database error.' });
        res.json({ success: true, date: dateStr1, data: rows || [] });
    });
});

// 📤 Admin: Heta ETA thiyana okkotama eka parata WhatsApp yawana API eka
app.post('/api/admin/send-bulk-whatsapp-tomorrow', async (req, res) => {
    const { admin_password } = req.body;
    if (!checkAdminAuth(admin_password)) {
        return res.status(401).json({ success: false, message: 'Invalid Admin Password!' });
    }

    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    
    const year = tomorrow.getFullYear();
    const month = String(tomorrow.getMonth() + 1).padStart(2, '0');
    const day = String(tomorrow.getDate()).padStart(2, '0');
    
    const dateStr1 = `${year}/${month}/${day}`;
    const dateStr2 = `${year}-${month}-${day}`;

    const query = `
        SELECT * FROM cargo 
        WHERE arrival_date LIKE ? 
           OR arrival_date LIKE ?
    `;

    db.all(query, [`%${dateStr1}%`, `%${dateStr2}%`], async (err, rows) => {
        if (err) {
            return res.status(500).json({ success: false, message: 'Database error.' });
        }
        
        if (!rows || rows.length === 0) {
            return res.json({ success: false, message: 'No customers found with tomorrow ETA.' });
        }

        let sentCount = 0;
        for (const row of rows) {
            if (row.customer_phone) {
                try {
                    await sendWhatsAppAlert(
                        row.customer_phone,
                        row.customer_name,
                        row.invoice_number,
                        "Arriving Tomorrow at " + (row.clearing_warehouse || 'Warehouse'),
                        row.arrival_date
                    );
                    sentCount++;
                } catch (e) {
                    console.error(`Failed to send for ${row.invoice_number}:`, e.message);
                }
            }
        }

        res.json({ success: true, message: `Successfully sent WhatsApp messages to ${sentCount} customer(s) for tomorrow ETA!` });
    });
});

app.get('/api/track/:invoice', (req, res) => {
    const invoice = req.params.invoice ? req.params.invoice.trim() : '';
    if (!invoice) return res.status(400).json({ success: false, message: 'Invoice number is required.' });

    db.get("SELECT * FROM cargo WHERE invoice_number = ?", [invoice], (err, row) => {
        if (err || !row) return res.status(404).json({ success: false, message: 'Invoice number not found.' });

        const resolvedWarehouse = extractWarehouseName(row.shipping_date, row.arrival_date, row.clearing_warehouse);
        if (resolvedWarehouse) row.clearing_warehouse = resolvedWarehouse;

        res.json({ success: true, data: row });
    });
});

app.post('/api/admin/sync-sheet', async (req, res) => {
    const { admin_password } = req.body;
    if (!checkAdminAuth(admin_password)) return res.status(401).json({ success: false, message: 'Invalid Admin Password!' });
    const result = await syncGoogleSheetData();
    res.json(result);
});

app.post('/api/admin/update', (req, res) => {
    const { admin_password, invoice_number, customer_name, customer_phone, shipping_date, arrival_date, clearing_warehouse, amount, full_price, status, destination } = req.body;

    if (!checkAdminAuth(admin_password)) return res.status(401).json({ success: false, message: 'Invalid Admin Password!' });
    if (!invoice_number) return res.status(400).json({ success: false, message: 'Invoice Number is required.' });

    const cleanInvoice = invoice_number.trim();
    const cleanAmount = parseFloat(amount) || 0;
    const cleanFullPrice = parseFloat(full_price) || cleanAmount;
    let cleanPhone = (customer_phone || '').replace(/[^0-9]/g, '');

    const query = `
        INSERT INTO cargo (invoice_number, customer_name, customer_phone, shipping_date, arrival_date, clearing_warehouse, amount, full_price, status, destination, whatsapp_sent, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, CURRENT_TIMESTAMP)
        ON CONFLICT(invoice_number) DO UPDATE SET
            customer_name = excluded.customer_name,
            customer_phone = excluded.customer_phone,
            shipping_date = excluded.shipping_date,
            arrival_date = excluded.arrival_date,
            clearing_warehouse = excluded.clearing_warehouse,
            amount = excluded.amount,
            full_price = excluded.full_price,
            status = excluded.status,
            destination = excluded.destination,
            whatsapp_sent = 0,
            updated_at = CURRENT_TIMESTAMP
    `;

    db.run(query, [cleanInvoice, customer_name, cleanPhone, shipping_date, arrival_date, clearing_warehouse, cleanAmount, cleanFullPrice, status, destination], function(err) {
        if (err) return res.status(500).json({ success: false, message: 'Failed to update.' });
        if (cleanPhone) sendWhatsAppAlert(cleanPhone, customer_name, cleanInvoice, status, arrival_date);
        res.json({ success: true, message: 'Record updated successfully!' });
    });
});

app.post('/api/admin/delete', (req, res) => {
    const { admin_password, invoice_number } = req.body;
    if (!checkAdminAuth(admin_password)) return res.status(401).json({ success: false, message: 'Invalid Admin Password!' });
    if (!invoice_number) return res.status(400).json({ success: false, message: 'Invoice Number is required.' });

    db.run("DELETE FROM cargo WHERE invoice_number = ?", [invoice_number.trim()], function(err) {
        if (err) return res.status(500).json({ success: false, message: 'Failed to delete.' });
        if (this.changes === 0) return res.status(404).json({ success: false, message: 'Record not found.' });
        res.json({ success: true, message: 'Invoice deleted successfully!' });
    });
});

app.post('/api/admin/bulk-update', (req, res) => {
    const { admin_password, shipments } = req.body;
    if (!checkAdminAuth(admin_password)) return res.status(401).json({ success: false, message: 'Invalid Admin Password!' });
    if (!Array.isArray(shipments) || shipments.length === 0) return res.status(400).json({ success: false, message: 'No shipment data.' });

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
        let count = 0;
        shipments.forEach(item => {
            if (item.invoice_number && item.invoice_number.trim()) {
                stmt.run([
                    item.arrival_date || '', item.clearing_warehouse || '', item.invoice_number.trim(),
                    item.customer_name || '', item.status || '', item.destination || '',
                    parseFloat(item.amount) || 0, (item.customer_phone || '').replace(/[^0-9]/g, ''), item.shipping_date || ''
                ]);
                count++;
            }
        });
        stmt.finalize();
        db.run("COMMIT", (err) => {
            if (err) return res.status(500).json({ success: false, message: 'Bulk upload failed.' });
            res.json({ success: true, message: `Successfully updated ${count} records!` });
        });
    });
});

app.get('/api/admin/records', (req, res) => {
    db.all("SELECT * FROM cargo ORDER BY updated_at DESC", [], (err, rows) => {
        if (err) return res.status(500).json({ success: false, message: 'Server error.' });
        res.json({ success: true, data: rows || [] });
    });
});

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
                                description: `Freight Amount: ¥${baseAmount.toLocaleString()} JPY | Fee: ¥${cardFee.toLocaleString()} JPY`,
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

app.get('/api/download-receipt/:invoice', (req, res) => {
    const invoice = req.params.invoice ? req.params.invoice.trim() : '';
    if (!invoice) return res.status(400).send('Invoice required.');

    db.get("SELECT * FROM cargo WHERE invoice_number = ?", [invoice], (err, row) => {
        if (err || !row) return res.status(404).send('Record not found.');

        const baseAmount = parseFloat(row.amount) || 0;
        const fullPrice = parseFloat(row.full_price) || baseAmount;
        const cardFee = Math.round(baseAmount * 0.042);
        const totalPayable = baseAmount + cardFee;
        const resolvedWarehouse = extractWarehouseName(row.shipping_date, row.arrival_date, row.clearing_warehouse) || row.clearing_warehouse || 'N/A';

        const doc = new PDFDocument({ size: 'A4', margin: 40 });
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename=Otek_Receipt_${invoice}.pdf`);
        doc.pipe(res);

        doc.fillColor('#0284c7').fontSize(20).text('OTEK EXPORT CO., LTD', { align: 'center', bold: true });
        doc.fontSize(9).fillColor('#475569').text('Panorama Cargo Logistics (Pvt) Ltd - Authorized Agent Network', { align: 'center' });
        doc.text('Japan & Sri Lanka International Freight & Cargo Operations', { align: 'center' });
        doc.moveDown(0.3);
        doc.moveTo(40, doc.y).lineTo(555, doc.y).strokeColor('#0284c7').stroke();
        doc.moveDown(0.8);

        doc.fillColor('#0f172a').fontSize(13).text('OFFICIAL FREIGHT INVOICE & RECEIPT', { align: 'center', underline: true });
        doc.moveDown(1);

        doc.fontSize(10).fillColor('#334155');
        doc.text(`Receipt Date: ${new Date().toLocaleDateString()}`);
        doc.text(`Invoice / Tracking No: ${row.invoice_number}`);
        doc.text(`Customer Name: ${row.customer_name || 'N/A'}`);
        doc.text(`Customer Phone: ${row.customer_phone || 'N/A'}`);
        doc.text(`Destination: ${row.destination || 'N/A'}`);
        doc.text(`Clearing Warehouse: ${resolvedWarehouse}`);
        doc.text(`Shipping Date: ${row.shipping_date || 'N/A'}`);
        doc.text(`Arrival Date (ETA): ${row.arrival_date || 'N/A'}`);
        doc.text(`Status: ${row.status || 'Pending'}`);
        doc.moveDown(1.2);

        doc.fillColor('#0369a1').fontSize(11).text('PAYMENT DETAILS BREAKDOWN', { bold: true });
        doc.moveDown(0.4);

        doc.fontSize(10).fillColor('#0f172a');
        doc.text(`Full Invoice Price (මුළු වටිනාකම): ¥ ${fullPrice.toLocaleString()} JPY`);
        doc.text(`Have to Pay (ගෙවිය යුතු ශේෂය): ¥ ${baseAmount.toLocaleString()} JPY`);
        doc.text(`Card Processing & Service Fee (4.2%): ¥ ${cardFee.toLocaleString()} JPY`);
        
        doc.moveDown(0.5);
        doc.moveTo(40, doc.y).lineTo(555, doc.y).strokeColor('#cbd5e1').stroke();
        doc.moveDown(0.5);

        doc.fontSize(12).fillColor('#15803d').text(`Total Amount Payable via Card: ¥ ${totalPayable.toLocaleString()} JPY`, { bold: true });

        doc.moveDown(2);
        doc.fontSize(7.5).fillColor('#64748b').text('Notice: Arrival dates and schedules are updated based on real-time data provided by shipping lines.', { align: 'center' });
        doc.moveDown(0.3);
        doc.text('Thank you for choosing Otek Export & Panorama Cargo Logistics!', { align: 'center', bold: true });

        doc.moveDown(3);
        doc.moveTo(40, doc.y).lineTo(555, doc.y).strokeColor('#0284c7').stroke();
        doc.moveDown(0.4);
        doc.fontSize(7.5).fillColor('#475569').text(
            'OTEK Export Co., Ltd, 560-8, Takatomi Matsuo-Machi, Sanmu-SHI, Chiba, 289-1522, Japan. ' +
            'Tel / Fax: 047 9856 224 | Mobile: +8190 9296 0709, +8170 2159 2609 | Email: otekmotors1@gmail.com',
            { align: 'center' }
        );

        doc.end();
    });
});

app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    syncGoogleSheetData();
});
