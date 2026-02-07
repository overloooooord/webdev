//task1.
let user = {
    nname: "John",
    years: 30
  };
  let {nname, years: age, isAdmin = false} = user;
  alert(nname ); // John
  alert( age ); // 30
  alert( isAdmin ); // false

//task2.
function topSalary(salaries) {
    let maxSalary = 0;
    let maxName = null;
    for(const [name, salary] of Object.entries(salaries)) {
      if (maxSalary < salary) {
        maxSalary = salary;
        maxName = name;
      }
    }
    return maxName;
  }