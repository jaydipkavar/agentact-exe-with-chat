document.addEventListener('DOMContentLoaded', function () {
  const recordingBtn = document.getElementById('recoridngBtn');
  if (recordingBtn) {
    recordingBtn.addEventListener('click', function () {
        window.location.replace('./main.html');
    });
  }
});
