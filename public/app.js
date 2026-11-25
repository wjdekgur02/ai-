const upload = document.querySelector('#upload');
upload?.addEventListener('submit', event => {
  event.preventDefault();
  if (!upload.reportValidity()) return;
  const data = new FormData(upload);
  const status = upload.querySelector('#upload-status');
  const progress = upload.querySelector('progress');
  const submit = upload.querySelector('button');
  const request = new XMLHttpRequest();
  request.open('POST', upload.action + '/' + encodeURIComponent(data.get('round')));
  request.setRequestHeader('X-CSRF-Token', data.get('_csrf'));
  data.delete('_csrf');
  data.delete('round');
  progress.hidden = false;
  status.hidden = false;
  progress.value = 0;
  submit.disabled = true;
  status.textContent = '파일을 전송하고 있습니다.';
  request.upload.addEventListener('progress', e => {
    if (e.lengthComputable) progress.value = Math.round(100 * e.loaded / e.total);
  });
  request.upload.addEventListener('load', () => { status.textContent = '서버에서 파일을 검사하고 있습니다.'; });
  request.responseType = 'json';
  request.addEventListener('load', () => {
    if (request.response?.url) location.assign(request.response.url);
    else {
      status.textContent = request.response?.message ?? '제출을 완료하지 못했습니다. 파일을 확인한 뒤 다시 시도해 주세요.';
      submit.disabled = false;
    }
  });
  request.addEventListener('error', () => {
    status.textContent = '서버 연결이 중단되었습니다. 제출 기록을 확인한 뒤 다시 시도해 주세요.';
    submit.disabled = false;
  });
  request.send(data);
});

const deadlineList = document.querySelector('#deadline-list');
const addDeadline = document.querySelector('#add-deadline');
addDeadline?.addEventListener('click', () => {
  const row = document.querySelector('#deadline-template').content.cloneNode(true);
  const remove = row.querySelector('.remove');
  remove.addEventListener('click', () => {
    remove.closest('.deadline-row').remove();
    addDeadline.disabled = false;
    addDeadline.focus();
  });
  deadlineList.append(row);
  deadlineList.lastElementChild.querySelector('input').focus();
  addDeadline.disabled = deadlineList.children.length >= 12;
});
