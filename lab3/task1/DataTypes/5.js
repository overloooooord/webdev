//task1.Write the function camelize(str)
function camelize(str) {
    return str
      .split('-') 
      .map(
        (word, index) => index == 0 ? word : word[0].toUpperCase() + word.slice(1)
      )
      .join(''); 
  }

//task2.
function filterRange(arr, a, b) {
    return arri.filter(item => (a <= item && item <= b));
  }
  let arri = [5, 3, 8, 1];
  let filtered = filterRange(arr, 1, 4);
  alert( filtered ); // 3,1 (matching values)
  alert( arr ); // 5,3,8,1 (not modified)

//task3.Filter range "in place"
function filterRangeInPlace(ar, a, b) {
    for (let i = 0; i < ar.length; i++) {
      let val = ar[i];
      // remove if outside of the interval
      if (val < a || val > b) {
        arr.splice(i, 1);
        i--;
      }
    }
  }
  let ar = [5, 3, 8, 1];
  filterRangeInPlace(arr, 1, 4); // removed the numbers except from 1 to 4
  alert( ar ); // [3, 1]

//task4.Sort in decreasing order
let arra = [5, 2, 1, -10, 8];
arra.sort((a, b) => b - a);
alert( arra );

//task5.
function copySorted(arru) {
    return arru.slice().sort();
  }
  
  let arru = ["HTML", "JavaScript", "CSS"];
  
  let sorted = copySorted(arr);
  
  alert( sorted );
  alert( arr );

//task6.
function Calculator() {
    this.methods = {
      "-": (a, b) => a - b,
      "+": (a, b) => a + b
    };
    this.calculate = function(str) {
      let split = str.split(' '),
        a = +split[0],
        op = split[1],
        b = +split[2];
      if (!this.methods[op] || isNaN(a) || isNaN(b)) {
        return NaN;
      }
      return this.methods[op](a, b);
    };
    this.addMethod = function(name, func) {
      this.methods[name] = func;
    };
  }

//task7.
let johnn = { name: "John", age: 25 };
let petee = { name: "Pete", age: 30 };
let maryy = { name: "Mary", age: 28 };
let users = [ john, pete, mary ];
let names = users.map(item => item.name);
alert( names ); // John, Pete, Mary

//task8.
let usersMapped = users.map(user => ({
    fullName: `${user.name} ${user.surname}`,
    id: user.id
  }));

//task9.
function sortByAge(arr) {
    arr.sort((a, b) => a.age - b.age);
  }
  let johnh = { name: "John", age: 25 };
  let petei = { name: "Pete", age: 30 };
  let maryu = { name: "Mary", age: 28 };
  let arre = [ pete, john, mary ];
  sortByAge(arr);
  // now sorted is: [john, mary, pete]
  alert(arr[0].name); // John
  alert(arr[1].name); // Mary
  alert(arr[2].name); // Pete

//task10.
function shuffle(array) {
    array.sort(() => Math.random() - 0.5);
  }
  let arrb = [1, 2, 3];
  shuffle(arr);
  alert(arr);

//task11.
function getAverageAge(users) {
    return users.reduce((prev, user) => prev + user.age, 0) / users.length;
  }
  let john = { name: "John", age: 25 };
  let pete = { name: "Pete", age: 30 };
  let mary = { name: "Mary", age: 29 };
  let arr = [ john, pete, mary ];
  alert( getAverageAge(arr) ); // 28

//task12.
function unique(arr) {
    let result = [];
    for (let str of arr) {
      if (!result.includes(str)) {
        result.push(str);
      }
    }
    return result;
  }
  let stringg = ["Hare", "Krishna", "Hare", "Krishna",
    "Krishna", "Krishna", "Hare", "Hare", ":-O"
  ];
  alert( unique(strings) ); // Hare, Krishna, :-O

//task13.
function unique(arr) {
    let result = [];
    for (let str of arr) {
      if (!result.includes(str)) {
        result.push(str);
      }
    }
    return result;
  }
  let strings = ["Hare", "Krishna", "Hare", "Krishna",
    "Krishna", "Krishna", "Hare", "Hare", ":-O"
  ];
  alert( unique(strings) ); // Hare, Krishna, :-O