const form = document.querySelector('#loginForm');
const button = document.querySelector('#loginButton');
const errorBox = document.querySelector('#loginError');

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  errorBox.hidden = true;
  button.disabled = true;

  try {
    const response = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: document.querySelector('#email').value,
        password: document.querySelector('#password').value
      })
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || 'Sign-in failed.');
    location.replace('/');
  } catch (error) {
    errorBox.textContent = error.message;
    errorBox.hidden = false;
  } finally {
    button.disabled = false;
  }
});
