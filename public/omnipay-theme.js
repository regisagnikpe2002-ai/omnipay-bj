/* OMNIPAY — thème jour/nuit (6 h–18 h) + logo en tête de page. Mémorise le choix sous la même clé que l'application. */
(function(){var d=document.documentElement;if(!d.getAttribute('data-theme')){var m='auto';try{m=localStorage.getItem('omTheme')||'auto'}catch(e){}
 var h=new Date().getHours();d.setAttribute('data-theme',m==='light'||m==='dark'?m:(h>=6&&h<18?'light':'dark'))}
 document.addEventListener('DOMContentLoaded',function(){if(document.querySelector('.om-logo,.brand img'))return;var t=document.querySelector('h1,h2');if(!t)return;
  var i=document.createElement('img');i.className='om-logo';i.src='/logo.svg';i.alt='OMNIPAY';i.width=60;i.height=60;t.parentNode.insertBefore(i,t)})})();
