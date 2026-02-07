alert( null || 2 || undefined );
//2
alert( alert(1) || 2 || alert(3) );
//1, 2
alert( 1 && null && 2 );
//null
alert( alert(1) && alert(2) );
//1
alert( null || 2 && 3 || 4 );
//3
if(age >= 14 && age <= 90)

if(!(age >= 14 && age <= 90))
if(age < 14 || age > 90)

if (-1 || 0) alert( 'first' ); // will run
if (-1 && 0) alert( 'second' ); // will not
if (null || -1 && 1) alert( 'third' ); // will run

let login = prompt("Who is there", '');
if(login == "Admin") {
  let password = prompt("Password?", '');
  if(password === "TheMaster"){
    alert("Welcome!");
  } else if(password === '' || password === null) {
    alert("Caneled");
  } else {
    alert("Wrong password");
  }
} else if(login === '' || password === null){
  alert("Canceled");
} else {
  alert("I don't know u");
}