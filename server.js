<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <title>Otek Export Cargo System</title>
    
    <link rel="manifest" href="/manifest.json">
    <meta name="theme-color" content="#05131f">
    <script src="https://js.stripe.com/v3/"></script>

    <style>
        html, body {
            height: 100%;
            margin: 0;
            padding: 0;
            overflow-x: hidden;
            overflow-y: auto;
            -webkit-overflow-scrolling: touch;
            background: linear-gradient(135deg, #05131f, #0b253a, #113856);
        }

        body { 
            font-family: Arial, sans-serif; 
            display: flex;
            justify-content: center;
            align-items: flex-start;
            padding: 15px;
            box-sizing: border-box;
        }

        #starCanvas {
            position: fixed;
            top: 0;
            left: 0;
            width: 100vw;
            height: 100vh;
            z-index: -1;
            pointer-events: none;
        }

        .card { 
            background: rgba(255, 255, 255, 0.96); 
            backdrop-filter: blur(10px);
            padding: 25px; 
            border-radius: 16px; 
            box-shadow: 0 10px 40px rgba(0,0,0,0.5); 
            width: 100%; 
            max-width: 950px;
            text-align: left; 
            margin: 20px auto;
            box-sizing: border-box;
            border: 1px solid rgba(255, 215, 0, 0.2);
        }

        .nav-buttons { 
            display: flex; 
            justify-content: space-between; 
            gap: 8px;
            margin-bottom: 20px; 
            border-bottom: 2px solid #eee; 
            padding-bottom: 10px; 
            flex-wrap: wrap;
        }
        .nav-btn { 
            background: none; 
            border: none; 
            font-size: 14px; 
            font-weight: bold; 
            cursor: pointer; 
            color: #666; 
            padding: 8px 12px; 
            border-radius: 6px;
            flex: 1;
            text-align: center;
        }
        .nav-btn.active { 
            color: #007bff; 
            border-bottom: 3px solid #007bff; 
            background: rgba(0, 123, 255, 0.05);
        }
        .tab-content { display: none; }
        .tab-content.active { display: block; }
        
        label { font-size: 13px; font-weight: bold; color: #333; display: block; margin-top: 12px; }
        input[type="text"], input[type="password"], input[type="number"], input[type="email"], input[type="file"] { width: 100%; padding: 12px; margin: 6px 0 10px 0; font-size: 14px; box-sizing: border-box; border: 1px solid #ccc; border-radius: 6px; }
        
        button.submit-btn { width: 100%; padding: 12px; font-size: 16px; background: #28a745; color: white; border: none; border-radius: 6px; cursor: pointer; margin-top: 10px; font-weight: bold; }
        button.admin-btn { background: #007bff; }
        button.sync-btn { background: #0284c7; }
        button.bulk-btn { background: #6f42c1; }
        button.delete-btn { background: #dc3545; }
        button.view-page-btn { background: #17a2b8; }
        button.stripe-pay-btn { background: #635bff; color: white; border: none; padding: 12px 24px; border-radius: 25px; font-weight: bold; cursor: pointer; font-size: 15px; }
        .section-divider { border-top: 1px solid #ddd; margin: 25px 0; }
        
        #result { margin-top: 18px; font-size: 14px; line-height: 1.6; word-break: break-word; }
        .result-box {
            background: #f8f9fa;
            border-left: 5px solid #28a745;
            padding: 16px;
            border-radius: 8px;
            box-sizing: border-box;
        }
        .result-item { margin-bottom: 8px; color: #2c3e50; }
        .brand-logo { max-width: 160px; height: auto; display: block; margin: 0 auto 15px auto; }

        .app-download-banner {
            background: linear-gradient(135deg, #FFD700, #ffa500);
            color: #05131f;
            padding: 14px 18px;
            border-radius: 12px;
            margin-top: 25px;
            display: flex;
            justify-content: space-between;
            align-items: center;
            font-weight: bold;
            flex-wrap: wrap;
            gap: 10px;
            box-sizing: border-box;
        }
        .app-download-btn {
            background: #05131f;
            color: #FFD700;
            border: none;
            padding: 10px 20px;
            border-radius: 25px;
            font-weight: bold;
            cursor: pointer;
        }
    </style>
</head>
<body>

    <canvas id="starCanvas"></canvas>

    <div class="card">
        <div class="nav-buttons">
            <button class="nav-btn active" id="btn-customer" onclick="switchTab('customer')">📦 Track Cargo</button>
            <button class="nav-btn" id="btn-payment" onclick="switchTab('payment')">💳 Direct Payment</button>
            <button class="nav-btn" id="btn-admin" onclick="switchTab('admin')">🛠️ Admin Panel</button>
        </div>

        <div id="customer" class="tab-content active">
            <img src="logo.png" alt="Logo" class="brand-logo" onerror="this.style.display='none'">
            <h3 style="margin-top:0; color:#28a745; text-align: center;">Otek Export Customer Tracking</h3>
            <label>Invoice Number:</label>
            <input type="text" id="invoice" placeholder="e.g. 8694 or INV-1001" onkeypress="if(event.key === 'Enter') track()">
            <button class="submit-btn" onclick="track()">Track Status</button>
            <div id="result"></div>
        </div>

        <div id="payment" class="tab-content">
            <h3 style="color:#635bff; text-align: center;">💳 Direct Invoice Payment</h3>
            <label>Customer Name:</label>
            <input type="text" id="customName">
            <label>Email Address:</label>
            <input type="email" id="customEmail">
            <label>Invoice Number:</label>
            <input type="text" id="customInv">
            <label>Amount JPY:</label>
            <input type="number" id="customAmount">
            <button class="stripe-pay-btn" style="width:100%; margin-top:10px;" onclick="makeDirectPayment()">💳 Pay Now</button>
        </div>

        <div id="admin" class="tab-content">
            <h3 style="color:#007bff; text-align: center;">Admin Panel</h3>
            <div id="adminUpdateForm" style="display: none;">
                <h4 style="color: #17a2b8;">View & Sync Database</h4>
                <div style="display: flex; gap: 10px; flex-wrap: wrap;">
                    <button class="submit-btn view-page-btn" style="flex:1;" onclick="window.open('/records.html', '_blank')">📂 Open Records</button>
                    <button class="submit-btn sync-btn" style="flex:1;" onclick="syncGoogleSheetNow()">🔄 Sync Sheets</button>
                </div>
                <div id="syncMsg"></div>

                <div class="section-divider"></div>
                <h4 style="margin: 0 0 5px 0;">Single Cargo Update</h4>
                <label>Shipping Date:</label>
                <input type="text" id="shippingDate">
                <label>Arrival Date (ETA):</label>
                <input type="text" id="arrivalDate">
                <label>Clearing Warehouse:</label>
                <input type="text" id="clearingWarehouse">
                <label>Invoice Number:</label>
                <input type="text" id="inv">
                <label>Customer Name:</label>
                <input type="text" id="name">
                <label>Customer Phone:</label>
                <input type="text" id="phone">
                <label>Have to Pay Amount:</label>
                <input type="number" id="chargeAmount">
                <label>Full Price:</label>
                <input type="number" id="fullPriceInput">
                <label>Status:</label>
                <input type="text" id="status">
                <label>Destination:</label>
                <input type="text" id="dest">
                <button class="submit-btn admin-btn" onclick="updateShipment()">Save Status</button>
                <div id="msg"></div>

                <div class="section-divider"></div>
                <h4 style="color: #dc3545;">Delete Record</h4>
                <label>Invoice to Delete:</label>
                <input type="text" id="deleteInv">
                <button class="submit-btn delete-btn" onclick="deleteShipment()">Delete</button>
                <div id="deleteMsg"></div>

                <div class="section-divider"></div>
                <h4 style="color: #6f42c1;">Bulk CSV Upload</h4>
                <input type="file" id="csvFile" accept=".csv">
                <button class="submit-btn bulk-btn" onclick="uploadCSV()">Upload CSV</button>
                <div id="bulkMsg"></div>

                <div class="section-divider"></div>
                <button style="background: #6c757d; color: white; border: none; padding: 10px; width: 100%; font-weight: bold; border-radius: 4px; cursor:pointer;" onclick="logoutAdmin()">Logout</button>
            </div>
        </div>

        <div class="app-download-banner">
            <span>📲 Get Otek Export Mobile App on your Phone!</span>
            <button type="button" class="app-download-btn" onclick="installMobileApp()">📥 Download App</button>
        </div>
    </div>

    <script>
        const canvas = document.getElementById('starCanvas');
        const ctx = canvas.getContext('2d');
        let stars = [];

        function resizeCanvas() {
            canvas.width = window.innerWidth;
            canvas.height = window.innerHeight;
        }
        window.addEventListener('resize', resizeCanvas);
        resizeCanvas();

        function createStars() {
            stars = [];
            const count = Math.floor(window.innerWidth / 12);
            for (let i = 0; i < count; i++) {
                stars.push({
                    x: Math.random() * canvas.width,
                    y: Math.random() * canvas.height,
                    size: Math.random() * 2.5 + 1,
                    speedY: Math.random() * 0.8 + 0.3,
                    opacity: Math.random() * 0.7 + 0.3
                });
            }
        }
        createStars();

        function drawStars() {
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            stars.forEach(s => {
                ctx.save();
                ctx.globalAlpha = s.opacity;
                ctx.beginPath();
                ctx.arc(s.x, s.y, s.size, 0, Math.PI * 2);
                ctx.fillStyle = '#FFD700';
                ctx.fill();
                ctx.restore();
                s.y += s.speedY;
                if (s.y > canvas.height) s.y = -20;
            });
            requestAnimationFrame(drawStars);
        }
        drawStars();

        let currentAdminPassword = sessionStorage.getItem('adminPassword') || "";

        function switchTab(tabName) {
            document.getElementById('customer').classList.remove('active');
            document.getElementById('payment').classList.remove('active');
            document.getElementById('admin').classList.remove('active');
            document.getElementById('btn-customer').classList.remove('active');
            document.getElementById('btn-payment').classList.remove('active');
            document.getElementById('btn-admin').classList.remove('active');

            if (tabName === 'admin') {
                if (!currentAdminPassword) {
                    const enteredPass = prompt("🔐 Enter Admin Password:");
                    if (!enteredPass) {
                        switchTab('customer');
                        return;
                    }
                    currentAdminPassword = enteredPass.trim();
                    sessionStorage.setItem('adminPassword', currentAdminPassword);
                }
                document.getElementById('adminUpdateForm').style.display = 'block';
            }
            document.getElementById(tabName).classList.add('active');
            document.getElementById('btn-' + tabName).classList.add('active');
        }

        async function track() {
            const inv = document.getElementById('invoice').value.trim();
            if (!inv) return alert('Please enter Invoice Number');
            const res = await fetch('/api/track/' + encodeURIComponent(inv));
            const data = await res.json();
            const div = document.getElementById('result');
            if(data.success) {
                const baseAmount = data.data.amount || 0;
                const fullPrice = data.data.full_price || baseAmount;
                div.innerHTML = `
                    <div class="result-box">
                        <div class="result-item"><strong>Invoice:</strong> ${data.data.invoice_number}</div>
                        <div class="result-item"><strong>Name:</strong> ${data.data.customer_name || '-'}</div>
                        <div class="result-item"><strong>Phone:</strong> ${data.data.customer_phone || '-'}</div>
                        <div class="result-item"><strong>Destination:</strong> ${data.data.destination || '-'}</div>
                        <div class="result-item"><strong>Full Price:</strong> ¥${fullPrice.toLocaleString()} JPY</div>
                        <div class="result-item"><strong>Have to Pay:</strong> ¥${baseAmount.toLocaleString()} JPY</div>
                        <div class="result-item"><strong>Status:</strong> ${data.data.status || '-'}</div>
                    </div>
                    <div style="text-align: center; margin-top: 15px;">
                        <a href="/api/download-receipt/${encodeURIComponent(data.data.invoice_number)}" target="_blank" style="background:#0284c7; color:white; padding:10px 18px; border-radius:6px; text-decoration:none; font-weight:bold; display:inline-block;">
                            📄 Download Official PDF Receipt
                        </a>
                    </div>
                `;
            } else {
                div.innerHTML = "<p style='color:red;'>Record not found.</p>";
            }
        }

        async function updateShipment() {
            const data = {
                admin_password: currentAdminPassword,
                shipping_date: document.getElementById('shippingDate').value,
                arrival_date: document.getElementById('arrivalDate').value,
                clearing_warehouse: document.getElementById('clearingWarehouse').value,
                invoice_number: document.getElementById('inv').value,
                customer_name: document.getElementById('name').value,
                customer_phone: document.getElementById('phone').value,
                amount: document.getElementById('chargeAmount').value,
                full_price: document.getElementById('fullPriceInput').value,
                status: document.getElementById('status').value,
                destination: document.getElementById('dest').value
            };
            const res = await fetch('/api/admin/update', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(data)
            });
            const result = await res.json();
            document.getElementById('msg').innerText = result.message;
            document.getElementById('msg').style.color = result.success ? 'green' : 'red';
        }

        async function deleteShipment() {
            const inv = document.getElementById('deleteInv').value.trim();
            if (!inv) return alert('Enter Invoice');
            const res = await fetch('/api/admin/delete', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ admin_password: currentAdminPassword, invoice_number: inv })
            });
            const result = await res.json();
            document.getElementById('deleteMsg').innerText = result.message;
            document.getElementById('deleteMsg').style.color = result.success ? 'green' : 'red';
        }

        async function uploadCSV() {
            const file = document.getElementById('csvFile').files[0];
            if (!file) return alert('Select CSV file');
            const reader = new FileReader();
            reader.onload = async function(e) {
                const lines = e.target.result.split(/\r?\n/);
                const shipments = [];
                for (let i = 1; i < lines.length; i++) {
                    const cols = lines[i].split(',').map(c => c.trim().replace(/^"|"$/g, ''));
                    if (cols.length >= 4) {
                        shipments.push({
                            arrival_date: cols[0] || '', clearing_warehouse: cols[1] || '',
                            invoice_number: cols[2] || '', customer_name: cols[3] || '',
                            status: cols[4] || '', destination: cols[5] || '',
                            amount: cols[6] || 0, customer_phone: cols[7] || '', shipping_date: cols[8] || ''
                        });
                    }
                }
                const res = await fetch('/api/admin/bulk-update', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ admin_password: currentAdminPassword, shipments })
                });
                const result = await res.json();
                document.getElementById('bulkMsg').innerText = result.message;
                document.getElementById('bulkMsg').style.color = result.success ? 'green' : 'red';
            };
            reader.readAsText(file);
        }

        function logoutAdmin() {
            currentAdminPassword = "";
            sessionStorage.removeItem('adminPassword');
            switchTab('customer');
        }

        async function syncGoogleSheetNow() {
            const res = await fetch('/api/admin/sync-sheet', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ admin_password: currentAdminPassword })
            });
            const result = await res.json();
            alert(result.message);
        }

        function installMobileApp() {
            alert("📱 Android/iOS: Open browser menu and select 'Add to Home Screen' or 'Install App'.");
        }
    </script>
</body>
</html>
