function checkAge(age) {
    return (age > 18) ? true : confirm("Did your parents allow you?"); 
  }

function checkAge(age) {
    return (age > 18) || confirm("Did your parents allow you?"); 
  }