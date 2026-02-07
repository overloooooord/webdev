//task1.Sum numbers from the visitor
let a = +prompt("The first number?", "");
let b = +prompt("The second number?", "");
alert( a + b );

//task2.Why 6.35.toFixed(1) == 6.3?
alert( (6.35 * 10).toFixed(20) ); // 63.5

//task3.Repeat until the input is a number
function readNumber() {
    let num;
    do {
      num = prompt("Enter a number please?", 0);
    } while ( !isFinite(num) );
    if (num === null || num === '') return null;
    return +num;
  }
  alert(`Read: ${readNumber()}`);

//task4.An occasional infinite loop. 
let i = 0;
while (i != 10) {
    i += 0.2;
  }
//Answer: Because i would never equal 10

//task5.A random number from min to max
function random(min, max) {
    return min + Math.random() * (max - min);
  }
  alert( random(1, 5) );
  alert( random(1, 5) );
  alert( random(1, 5) );

//task6.A random integer from min to max
function randomInteger(min, max) {
    let rand = min - 0.5 + Math.random() * (max - min + 1);
    return Math.round(rand);
  }
  alert( randomInteger(1, 3) );