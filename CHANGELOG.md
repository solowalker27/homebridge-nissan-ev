# Changelog

## 0.3.0

- Automatically download and provision a private Python runtime and all Nissan dependencies on first use; no terminal configuration is required.
- Show setup progress in Homebridge UI and recover from an old system Python setting.
- Share a setup lock across the UI and running platform; verify helper downloads before execution.
- Handle password paste inside the setup iframe, including Safari's text clipboard format.
- Add an accessible Show/Hide password button.
- Preserve entered passwords during background setup and connection checks.
- Capture sign-in credentials before asynchronous settings reads; clear and conceal the submitted password immediately.

## 0.2.0

- Initial npm release with MyNISSAN account sign-in and connection checks in Homebridge UI.
