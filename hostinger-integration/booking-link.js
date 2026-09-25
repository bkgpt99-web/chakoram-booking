/* Optional adapter for existing buttons that currently open the WhatsApp enquiry.
   Add data-chakoram-book to EACH button you want to send to the booking engine.
   Upload this file to Hostinger, then include:
   <script src="/booking-link.js" defer></script>
   A normal <a href="https://book.chakoramhomestay.in/"> is preferred where possible. */
document.addEventListener('click',function(event){
  const button=event.target.closest('[data-chakoram-book]');
  if(!button)return;
  event.preventDefault();event.stopImmediatePropagation();
  window.location.assign('https://book.chakoramhomestay.in/');
},true);
