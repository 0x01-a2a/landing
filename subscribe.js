const subscribeForms = document.querySelectorAll('[data-subscribe-form]')

subscribeForms.forEach((form) => {
  const emailInput = form.querySelector('input[type="email"]')
  const button = form.querySelector('button[type="submit"]')
  const feedback = form.querySelector('[data-subscribe-feedback]')
  const defaultContent = button.innerHTML

  form.addEventListener('submit', async (event) => {
    event.preventDefault()

    if (!form.checkValidity()) {
      form.reportValidity()
      return
    }

    button.disabled = true
    button.textContent = 'Subscribing…'
    feedback.textContent = ''
    feedback.className = 'subscribe-feedback'

    try {
      const request = await fetch(form.dataset.subscribeEndpoint, {
        method: 'POST',
        mode: 'cors',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: emailInput.value,
          company: form.querySelector('[name="company"]').value,
          source: form.dataset.subscribeSource,
        }),
      })
      const result = await request.json().catch(() => ({}))

      if (!request.ok) throw new Error(result.error || 'Something went wrong. Please try again.')

      form.reset()
      feedback.textContent = result.message || 'You are on the list.'
      feedback.classList.add('is-success')
    } catch (error) {
      feedback.textContent = error.message || 'Something went wrong. Please try again.'
      feedback.classList.add('is-error')
    } finally {
      button.disabled = false
      button.innerHTML = defaultContent
    }
  })
})
