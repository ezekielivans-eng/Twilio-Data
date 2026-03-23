(async function() {
    const cacheKey = `subaccount_detail_${ACCOUNT_SID}_${getDateParams()}`;
    const cached = sessionStorage.getItem(cacheKey);

    if (cached) {
        const data = JSON.parse(cached);
        renderPage(data);
        return;
    }

    showLoading();
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 120000);
        const res = await fetch(`/api/subaccounts/${ACCOUNT_SID}?${getDateParams()}`, { signal: controller.signal });
        clearTimeout(timeoutId);
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.error || `Server error (${res.status})`);
        }
        const data = await res.json();
        sessionStorage.setItem(cacheKey, JSON.stringify(data));
        renderPage(data);
    } catch(e) {
        showError(e.name === 'AbortError' ? 'Request timed out. Try a shorter date range.' : e.message);
    }
})();

function renderPage(data) {
    document.getElementById('accountTitle').textContent = `Sub-Account: ${data.account_name}`;
    renderKPIs(data.status_summary);
    renderStatusChart(data.status_summary);
    renderTimelineChart(data.daily);
    renderTemplateChart(data.templates);
    renderTemplatesTable(data.templates);
    if (data.limit_reached) {
        const warn = document.createElement('div');
        warn.className = 'limit-warning';
        warn.innerHTML = 'Message fetch limit reached. Totals may be approximate. Try a shorter date range for exact numbers.';
        document.querySelector('.container').insertBefore(warn, document.getElementById('loading').nextSibling);
    }
    hideLoading();
}

function renderKPIs(s) {
    document.getElementById('kpiTotal').textContent = s.total.toLocaleString();
    document.getElementById('kpiDelivery').textContent = s.delivery_rate + '%';
    document.getElementById('kpiRead').textContent = s.read_rate + '%';
    document.getElementById('kpiError').textContent = s.error_rate + '%';
}

function renderStatusChart(s) {
    new Chart(document.getElementById('statusChart'), {
        type: 'doughnut',
        data: {
            labels: ['Delivered', 'Read', 'Sent', 'Failed', 'Undelivered', 'Queued'],
            datasets: [{
                data: [s.delivered, s.read, s.sent, s.failed, s.undelivered, s.queued],
                backgroundColor: ['#25d366', '#0dcaf0', '#ffc107', '#dc3545', '#fd7e14', '#6c757d']
            }]
        },
        options: { responsive: true, plugins: { legend: { position: 'bottom' } } }
    });
}

function renderTimelineChart(daily) {
    const colors = {
        delivered: '#25d366', read: '#0dcaf0', sent: '#ffc107',
        failed: '#dc3545', undelivered: '#fd7e14', queued: '#6c757d'
    };
    new Chart(document.getElementById('timelineChart'), {
        type: 'line',
        data: {
            labels: daily.dates,
            datasets: Object.entries(daily.series).map(([status, values]) => ({
                label: status.charAt(0).toUpperCase() + status.slice(1),
                data: values,
                borderColor: colors[status] || '#999',
                backgroundColor: (colors[status] || '#999') + '20',
                fill: true, tension: 0.3
            }))
        },
        options: {
            responsive: true,
            scales: { y: { beginAtZero: true } },
            plugins: { legend: { position: 'bottom' } }
        }
    });
}

function renderTemplateChart(templates) {
    const top = templates.slice(0, 10);
    new Chart(document.getElementById('templateChart'), {
        type: 'bar',
        data: {
            labels: top.map(t => t.template_name.substring(0, 30)),
            datasets: [
                { label: 'Delivery Rate', data: top.map(t => t.delivery_rate), backgroundColor: '#25d366' },
                { label: 'Read Rate', data: top.map(t => t.read_rate), backgroundColor: '#0dcaf0' },
                { label: 'Error Rate', data: top.map(t => t.error_rate), backgroundColor: '#dc3545' }
            ]
        },
        options: {
            responsive: true,
            scales: { y: { beginAtZero: true, max: 100 } },
            plugins: { legend: { position: 'bottom' } }
        }
    });
}

function renderTemplatesTable(templates) {
    document.getElementById('templatesBody').innerHTML = templates.map(t => `
        <tr>
            <td>${t.template_name}</td>
            <td>${t.total.toLocaleString()}</td>
            <td>${t.delivered.toLocaleString()}</td>
            <td>${t.read.toLocaleString()}</td>
            <td>${t.failed.toLocaleString()}</td>
            <td><span class="badge badge-success">${t.delivery_rate}%</span></td>
            <td><span class="badge badge-info">${t.read_rate}%</span></td>
            <td><span class="badge ${t.error_rate > 5 ? 'badge-danger' : 'badge-warning'}">${t.error_rate}%</span></td>
        </tr>
    `).join('');
}
