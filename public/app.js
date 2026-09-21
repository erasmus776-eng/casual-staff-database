let currentUserRole = null;
const form=document.getElementById('searchForm');
const q=document.getElementById('q');
const body=document.getElementById('body');
const results=document.getElementById('results');
const status=document.getElementById('status');

function esc(s){return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}

form.addEventListener('submit',async e=>{
  e.preventDefault();
  const query=q.value.trim();
  if(!query){status.textContent='Enter a name, LGA, phone number, qualification or ministry.';results.hidden=true;return;}
  status.textContent='Searching...';
  try{
    const r=await fetch('/api/search?q='+encodeURIComponent(query),{headers:{'Accept':'application/json'}});
    if(r.status===401){location.href='/';return;}
    const data=await r.json();
    if(!r.ok) throw new Error(data.error||'Search failed');
    body.innerHTML='';
    for(const x of data.records){
      const tr=document.createElement('tr');
      const actions = currentUserRole === 'admin'
  ? `<button class="editBtn" data-id="${esc(x.id)}" data-sno="${esc(x.sno)}">Edit</button> <button class="deleteBtn" data-id="${esc(x.id)}" data-sno="${esc(x.sno)}">Delete</button>`
  : '';

tr.innerHTML=`<td>${esc(x.sno)}</td><td>${esc(x.name)}</td><td>${esc(x.ministry)}</td><td>${esc(x.qualification)}</td><td>${esc(x.lga)}</td><td>${esc(x.phone)}</td><td>${actions}</td>`;
      body.appendChild(tr);
    }
    results.hidden=false;
    status.textContent=`${data.records.length} matching record(s).`;
    if(data.records.length===0) results.hidden=true;
  }catch(err){status.textContent=err.message||'Search failed.';results.hidden=true;}
});


const addForm = document.getElementById('addStaffForm');
const addStatus = document.getElementById('addStatus');

if (addForm) {
  addForm.addEventListener('submit', async e => {
    e.preventDefault();

    addStatus.textContent = 'Saving...';

    const data = {
      name: document.getElementById('staffName').value.trim(),
      ministry: document.getElementById('staffMinistry').value.trim(),
      qualification: document.getElementById('staffQualification').value.trim(),
      lga: document.getElementById('staffLga').value.trim(),
      phone: document.getElementById('staffPhone').value.trim()
    };

    try {
      const r = await fetch('/api/records', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify(data)
      });

      if (r.status === 401) {
        location.href = '/';
        return;
      }

      const result = await r.json();

      if (!r.ok) {
        throw new Error(result.error || 'Could not add record.');
      }

      addStatus.textContent =
        `Record added successfully. S/N: ${result.record.sno}`;

      addForm.reset();

    } catch (err) {
      addStatus.textContent = err.message || 'Could not add record.';
    }
  });
}
document.addEventListener('click', async e => {
  if (!e.target.classList.contains('editBtn')) return;

  const id = e.target.dataset.id;
const sno = e.target.dataset.sno;

  const name = prompt('Enter the staff full name:');
  if (name === null) return;

  const ministry = prompt('Enter the ministry / department:');
  if (ministry === null) return;

  const qualification = prompt('Enter the qualification:');
  if (qualification === null) return;

  const lga = prompt('Enter the L.G.A.:');
  if (lga === null) return;

  const phone = prompt('Enter the phone number:');
  if (phone === null) return;

  try {
    const r = await fetch('/api/records/' + encodeURIComponent(id), {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify({
        name,
        ministry,
        qualification,
        lga,
        phone
      })
    });

    if (r.status === 401) {
      location.href = '/';
      return;
    }

    const result = await r.json();

    if (!r.ok) {
      throw new Error(result.error || 'Could not update record.');
    }

    alert('Staff record updated successfully.');

  } catch (err) {
    alert(err.message || 'Could not update record.');
  }
});
document.addEventListener('click', async e => {
  if (!e.target.classList.contains('deleteBtn')) return;

  const id = e.target.dataset.id;
const sno = e.target.dataset.sno;

  const confirmed = confirm(
    'Are you sure you want to delete staff record S/N ' + sno + '?'
  );

  if (!confirmed) return;

  try {
    const r = await fetch('/api/records/' + encodeURIComponent(id), {
      method: 'DELETE',
      headers: {
        'Accept': 'application/json'
      }
    });

    if (r.status === 401) {
      location.href = '/';
      return;
    }

    const result = await r.json();

    if (!r.ok) {
      throw new Error(result.error || 'Could not delete record.');
    }

    alert('Staff record deleted successfully.');

    form.dispatchEvent(new Event('submit'));

  } catch (err) {
    alert(err.message || 'Could not delete record.');
  }
});


    
const excelForm = document.getElementById('excelImportForm');
const excelFile = document.getElementById('excelFile');
const excelStatus = document.getElementById('excelStatus');

if (excelForm) {
  excelForm.addEventListener('submit', async e => {
    e.preventDefault();

    const file = excelFile.files[0];

    if (!file) {
      excelStatus.textContent = 'Please select an Excel file.';
      return;
    }

    excelStatus.textContent = 'Reading Excel file...';

    try {
      const reader = new FileReader();

      reader.onload = async function () {
        try {
          const base64 = reader.result.split(',')[1];

          excelStatus.textContent = 'Uploading Excel file...';

          const r = await fetch('/api/import-excel', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Accept': 'application/json'
            },
            body: JSON.stringify({
              file: base64
            })
          });

          if (r.status === 401) {
            location.href = '/';
            return;
          }

          const result = await r.json();

          if (!r.ok) {
            throw new Error(result.error || 'Excel import failed.');
          }

          excelStatus.textContent =
  `Import successful. ${result.imported} imported, ${result.duplicatesSkipped} duplicates skipped.`;

          excelForm.reset();

        } catch (err) {
          excelStatus.textContent =
            err.message || 'Excel import failed.';
        }
      };

      reader.onerror = function () {
        excelStatus.textContent = 'Could not read the Excel file.';
      };

      reader.readAsDataURL(file);

    } catch (err) {
      excelStatus.textContent =
        err.message || 'Excel import failed.';
    }
  });
}
// Check the logged-in user's role
async function setupRolePermissions() {
  try {
    const r = await fetch('/api/me', {
      headers: {
        'Accept': 'application/json'
      }
    });

    if (r.status === 401) {
      location.href = '/';
      return;
    }

    const user = await r.json();

    if (user.role !== 'admin') {
      const addSection = document.getElementById('addStaffSection');
      const excelSection = document.getElementById('excelImportSection');

      if (addSection) addSection.hidden = true;
      if (excelSection) excelSection.hidden = true;

      document.querySelectorAll('.editBtn, .deleteBtn').forEach(button => {
        button.hidden = true;
      });
    }

  } catch (err) {
    console.error('Could not check user role:', err);
  }
}

setupRolePermissions();
