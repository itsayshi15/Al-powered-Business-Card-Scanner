# Al-powered Business Card Scanner

An automated tool built with **Google Apps Script** and **Google Gemini API**. This project reads business card images from a Google Drive folder, extracts contact details using AI, checks for duplicate contacts, saves the information into a Google Sheet, and moves processed photos to another folder.

---

## Why Choose This Scanner? (What Makes It Unique)

Unlike standard OCR applications or basic business card scanners, this tool is built for total privacy, zero monthly costs, and reliable processing:

* **100% Free & Private:** Most business card apps charge monthly subscriptions or store your sensitive contacts on third-party servers. This scanner runs completely inside your own Google account using your private Gemini API key and Drive folder.
* **Smart Language & Numeral Conversion:** Standard OCR tools fail when reading cards from different regions. This scanner converts foreign digits (like Bangla `০-৯` or Arabic-Indic `٠-٩`) into standard `0-9` numbers automatically and cleans up email formatting.
* **Built for Speed with Parallel Processing:** Instead of reading cards slowly one by one, it processes images in parallel batches. It can download image thumbnails, query Gemini, and write results to Sheets simultaneously.
* **Smart Failures & Dynamic Fallbacks:** If Gemini is busy or hits a rate limit, the scanner automatically falls back to backup AI models, waits using exponential backoff, and retries without crashing or dropping cards.
* **Automated Workflow & Duplicate Protection:** It checks phone numbers and emails against existing Google Sheet records to prevent duplicates and moves finished card photos to a `Processed` subfolder so you never scan the same card twice.

---

## Features

* **Extracts Contact Information:** Automatically reads names, job titles, company names, phone numbers, emails, websites, and addresses from images.
* **Multilingual & Number Support:** Reads text in different languages and normalizes non-Latin numbers.
* **Fast Batch Processing:** Processes multiple card images at the same time using parallel requests.
* **Duplicate Detection:** Checks phone numbers and emails against existing Google Sheet records to find potential duplicates.
* **Automatic File Management:** Moves completed card images into a `Processed` subfolder so they are not scanned again.
* **Web User Interface:** Includes a simple mobile-friendly webpage to run scans, check progress, and view summary results.

---

## Project Files

* **`Code.gs`**: The backend script that handles folder scanning, calling the Gemini API, cleaning data, checking duplicates, and updating Google Sheets.
* **`Index.html`**: The frontend user interface for setting up the folder link, API key, and controlling the scanning process.

---

## How It Works

1. **Upload Images:** Place business card photos (`.jpg`, `.png`, `.webp`, `.heic`) into your Google Drive folder.
2. **Scan Folder:** Click the **Scan cards** button on the web app interface.
3. **AI Processing:** The script sends image data to Google's Gemini Vision model.
4. **Validation & Deduplication:** Cleaned data is checked for missing information or matching phone numbers/emails.
5. **Save & Move:** Results are appended to the Google Sheet, and the image files are moved to the `Processed` folder.

---

## Setup Instructions

### 1. Requirements
* A Google Account (Google Drive and Google Sheets).
* A free **Gemini API Key** from [Google AI Studio](https://aistudio.google.com/).

### 2. Apps Script Installation
1. Open a new or existing **Google Sheet**.
2. In the top menu, go to **Extensions** → **Apps Script**.
3. Replace the code in `Code.gs` with the code provided in this repository's `Code.gs` file.
4. Add an HTML file named `Index.html` and paste the code from this repository's `Index.html` file.

### 3. Deploy the Web App
1. Click **Deploy** → **New deployment**.
2. Select **Web app** as the type.
3. Set **Execute as** to `Me` and **Who has access** to `Only myself`.
4. Click **Deploy** and authorize the requested permissions.

### 4. How to Use
1. Open the web app link.
2. Paste your **Google Drive Folder link** and **Gemini API Key**.
3. Click **Save and connect**, then start scanning your cards[cite: 1, 2]!

---

## Google Sheet Structure

Data is automatically organized in the `Cards` tab with these columns:

| Column Name | Description |
| :--- | :--- |
| **Serial No** | Automatic serial number. |
| **Name** | Full name of the person. |
| **Designation** | Job position or title. |
| **Company** | Company or organization name. |
| **Phone** | Extracted phone and mobile numbers. |
| **Email** | Lowercase email address. |
| **Website** | Website address. |
| **Address** | Full physical address. |
| **Status** | Shows `OK`, `Check`, or `Possible duplicate`. |
| **Notes** | Warnings or issue details. |
| **Source File** | Original file name in Drive. |
| **Card Image Link** | Direct link to open the photo. |
| **Scanned At** | Timestamp of when the card was scanned. |

---

## License

This project is open-source and free to use under the [MIT License](LICENSE).
