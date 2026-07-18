const editor = document.querySelector('#editor');
const result = document.querySelector('#result');
const filename = document.querySelector('#filename');
let current = 'needs';

document.addEventListener('click', async (event) => {
  const load = event.target.closest('[data-load]');
  if (load) await loadFile(load.dataset.load);
  if (event.target.id === 'validate') validate();
  if (event.target.id === 'download') download();
});

async function loadFile(name) {
  current = name;
  filename.textContent = `data/${name}.json`;
  try {
    const response = await fetch(`./data/${name}.json?v=${Date.now()}`);
    const data = await response.json();
    editor.value = JSON.stringify(data, null, 2);
    result.textContent = `Завантажено ${Array.isArray(data) ? data.length : 0} записів.`;
  } catch {
    editor.value = '[]';
    result.textContent = 'Не вдалося завантажити файл.';
  }
}

function validate() {
  try {
    const data = JSON.parse(editor.value);
    if (!Array.isArray(data)) throw new Error('Кореневе значення має бути масивом.');
    result.textContent = `JSON коректний. Записів: ${data.length}.`;
  } catch (error) {
    result.textContent = `Помилка: ${error.message}`;
  }
}

function download() {
  try {
    const data = JSON.parse(editor.value);
    const blob = new Blob([JSON.stringify(data, null, 2) + '\n'], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url; link.download = `${current}.json`; link.click();
    URL.revokeObjectURL(url);
    result.textContent = `Файл ${current}.json завантажено.`;
  } catch (error) {
    result.textContent = `Не можна завантажити: ${error.message}`;
  }
}

loadFile('needs');
