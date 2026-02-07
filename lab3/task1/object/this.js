function makeUser() {
    return {
      name: "John",
      ref: this
    };
  }
  
  let user = makeUser();
  
  alert( user.ref.name ); // What's the result?

//error, this doesnt work like that
//it should be more like this:
function makeUser() {
    return {
        name: "John",
        ref() {
            return this;
        }
    };
    let user = makeUser();

    alert(user.ref().name);
}


let calculator = {
    read() {
        let a = +prompt("a?", '');
        let b = +prompt("b?", '');
    },
    sum() {
        return this.a + this.b;
    },
    mul() {
        return this.a * this.b;
    }
};
  
calculator.read();
alert( calculator.sum() );
alert( calculator.mul() );


let ladder = {
    step: 0,
    up() {
      this.step++;
      return this;
    },
    down() {
      this.step--;
      return this;
    },
    showStep: function() { // shows the current step
      alert( this.step );
      return this;
    }
  };