import json
with open("persons.json","r") as f:
    persons = json.load(f)
    

candidates = [
        "Andrew Yang",
        "Beto O'rourke",
        "John Delaney",
        "Julian Castro",
        "Kamala Devi Harris",
        "Cory Anthony Booker",
        "Tulsi Gabbard",
        "Elizabeth Warren",
        "Amy Klobuchar",
        "Bernard Sanders",
        "Jay Robert Inslee",
        "John Hickenlooper",
        "Kirsten Gillibrand",
        "Wayne Messam",
        "Timothy J. Ryan",
        "Eric Swalwell",
        "Maurice Robert (Mike) Gravel",
        "Pete Buttigieg",
        "Seth Moulton",
        "Jr.  Joseph Robinette Biden",
        "Michael F. Bennet",
        "Steve Bullock",
        "Bill de Blasio",
        "Marianne Williamson",
        "Stacey Abrams"
        ]

records = {}


for c in candidates:
    if c in persons.keys():
        records[c] = persons[c]
    else:
        print(c + " has never been in Congress")