const nodemailer = require('nodemailer');
require('dotenv').config();

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

async function sendOTP(email, otp) {
  await transporter.sendMail({
    from: `"Algopath Auth" <${process.env.EMAIL_USER}>`,
    to: email,
    subject: "Your Discord OTP",
    text: `Your OTP is: ${otp}`,
  });
}

module.exports = { sendOTP };
