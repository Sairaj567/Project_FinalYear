document.addEventListener('DOMContentLoaded', () => {

  // --- Theme Toggler ---
  const themeToggle = document.getElementById('theme-toggle');
  const currentTheme = localStorage.getItem('theme');

  // Apply saved theme on load
  if (currentTheme === 'dark') {
    document.body.classList.add('dark-theme');
    themeToggle.textContent = '☀️'; // Sun emoji
  } else {
    themeToggle.textContent = '🌙'; // Moon emoji
  }

  // Toggle theme on click
  themeToggle.addEventListener('click', () => {
    document.body.classList.toggle('dark-theme');

    let theme = 'light';
    if (document.body.classList.contains('dark-theme')) {
      theme = 'dark';
      themeToggle.textContent = '☀️';
    } else {
      themeToggle.textContent = '🌙';
    }
    // Save preference
    localStorage.setItem('theme', theme);
  });


  // --- Chart.js for Admin Dashboard ---
  const chartCanvas = document.getElementById('placementChart');
  if (chartCanvas) {
    // Get the data passed from EJS (it's in a hidden element)
    const packageData = JSON.parse(document.getElementById('chartData').value);

    // Process data for the chart (create bins/ranges)
    const bins = { '0-5': 0, '5-10': 0, '10-15': 0, '15-20': 0, '20+': 0 };
    packageData.forEach(pkg => {
      if (pkg <= 5) bins['0-5']++;
      else if (pkg <= 10) bins['5-10']++;
      else if (pkg <= 15) bins['10-15']++;
      else if (pkg <= 20) bins['15-20']++;
      else bins['20+']++;
    });

    const chartData = {
      labels: Object.keys(bins),
      datasets: [{
        label: 'Package Distribution (LPA)',
        data: Object.values(bins),
        backgroundColor: [
          'rgba(255, 99, 132, 0.6)',
          'rgba(54, 162, 235, 0.6)',
          'rgba(255, 206, 86, 0.6)',
          'rgba(75, 192, 192, 0.6)',
          'rgba(153, 102, 255, 0.6)'
        ],
        borderColor: [
          'rgba(255, 99, 132, 1)',
          'rgba(54, 162, 235, 1)',
          'rgba(255, 206, 86, 1)',
          'rgba(75, 192, 192, 1)',
          'rgba(153, 102, 255, 1)'
        ],
        borderWidth: 1
      }]
    };

    // Chart.js is not loaded via npm, so we check if the script is loaded
    // We will add the script tag in the admin dashboard EJS file
    if (typeof Chart !== 'undefined') {
      new Chart(chartCanvas, {
        type: 'bar', // 'bar', 'pie', 'doughnut'
        data: chartData,
        options: {
          responsive: true,
          maintainAspectRatio: false,
          scales: {
            y: {
              beginAtZero: true
            }
          },
          plugins: {
            legend: {
              display: false
            },
            title: {
              display: true,
              text: 'Package Distribution (LPA)'
            }
          }
        }
      });
    } else {
      console.error('Chart.js library is not loaded.');
    }
  }

// === NEW: RESUME BUILDER LOGIC START ===

  // 1. Template Switcher
  const templateSelector = document.getElementById('template-selector');
  const resumePreview = document.getElementById('resume-to-print');

  if (templateSelector && resumePreview) {
    templateSelector.addEventListener('change', (e) => {
      // Remove all old template classes
      resumePreview.classList.remove('template-modern', 'template-minimal');
      // Add the new one if it's not the default
      if (e.target.value) {
        resumePreview.classList.add(e.target.value);
      }
    });
  }

  // 2. AI Review
  const aiReviewBtn = document.getElementById('get-ai-review');
  const aiReviewBox = document.getElementById('ai-review-box');

  if (aiReviewBtn && aiReviewBox) {
    aiReviewBtn.addEventListener('click', async () => {
      aiReviewBtn.disabled = true;
      aiReviewBox.classList.add('loading');
      aiReviewBox.textContent = 'Generating AI review, please wait...';

      try {
        const response = await fetch('/student/resume-builder/ai-review', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          }
        });

        const data = await response.json();
        
        if (data.success) {
          aiReviewBox.textContent = data.review;
        } else {
          aiReviewBox.textContent = data.review; // Show error message
        }

      } catch (error) {
        console.error('Fetch Error:', error);
        aiReviewBox.textContent = 'An error occurred. Please try again.';
      } finally {
        aiReviewBtn.disabled = false;
        aiReviewBox.classList.remove('loading');
      }
    });
  }
  // === NEW: RESUME BUILDER LOGIC END ===

});
// === NEW N8N WEBHOOK SUBMISSION LOGIC ===
document.addEventListener('DOMContentLoaded', () => {
  
  const applyButton = document.getElementById('n8n-apply-button');
  const statusDiv = document.getElementById('application-status');

  if (applyButton) {
    applyButton.addEventListener('click', async () => {
      // 1. Get all the data from the button's "data-*" attributes
      const { 
        jobId, 
        stuId, 
        stuName, 
        stuMail, 
        portfolio, 
        webhookUrl 
      } = applyButton.dataset;

      // 2. Disable button to prevent double-clicks
      applyButton.disabled = true;
      applyButton.textContent = 'Applying...';
      statusDiv.innerHTML = '';

      // 3. Construct the URL with Query Parameters
      const params = new URLSearchParams();
      params.append('job_id', jobId);
      params.append('stu_id', stuId);
      params.append('sti_name', stuName);
      params.append('stu_mail', stuMail);
      if (portfolio) {
        params.append('portfolio', portfolio);
      }
      
      const fullUrl = `${webhookUrl}?${params.toString()}`;

      try {
        // 4. Send the GET request to the n8n webhook
        const response = await fetch(fullUrl, { method: 'GET' });

        // n8n webhooks usually respond with a 200 OK
        if (response.ok) {
          // Success!
          applyButton.textContent = 'Applied!';
          statusDiv.innerHTML = `
            <div class="card" style="background-color: var(--status-selected); color: white; padding: 15px;">
              Application Submitted Successfully! The company has received your details.
            </div>`;
        } else {
          // Handle HTTP errors
          throw new Error(`The server responded with status ${response.status}`);
        }
      } catch (error) {
        // Handle network errors
        console.error('Error submitting application:', error);
        statusDiv.innerHTML = `
          <div class="card" style="background-color: var(--status-rejected); color: white; padding: 15px;">
            An error occurred. Please try again.
          </div>`;
        applyButton.disabled = false;
        applyButton.textContent = 'Submit Application';
      }
    });
  }
});
